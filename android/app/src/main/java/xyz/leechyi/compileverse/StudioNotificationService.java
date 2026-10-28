package xyz.leechyi.compileverse;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** User initiated polling, one private cursor per server; no model execution or approval actions. */
public class StudioNotificationService extends Service {
    static volatile boolean running = false;
    static final String MONITOR = "roamdeck.monitor", ALERTS = "roamdeck.alerts";
    private static final String STOP = "roamdeck.pause";
    private static final int ONGOING = 711;
    private ScheduledExecutorService worker; private volatile boolean stopped; private android.os.PowerManager.WakeLock wake;
    private SharedPreferences prefs() { return StudioNotificationsPlugin.storage(this); }
    private NotificationManager manager() { return (NotificationManager)getSystemService(NOTIFICATION_SERVICE); }
    static void createChannels(NotificationManager manager) {
        NotificationChannel monitor = new NotificationChannel(MONITOR, "后台监听状态", NotificationManager.IMPORTANCE_LOW); monitor.setShowBadge(false);
        NotificationChannel alerts = new NotificationChannel(ALERTS, "任务与批准提醒", NotificationManager.IMPORTANCE_HIGH); alerts.setDescription("任务完成、失败以及需要手动回应时提醒"); alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(monitor); manager.createNotificationChannel(alerts);
    }
    @Override public void onCreate() {
        super.onCreate(); stopped = false;
        createChannels(manager());
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); else startForeground(ONGOING, ongoing());
        // 息屏进入 Doze 后 CPU 休眠会让轮询停摆，监听开启期间持有 CPU 唤醒锁（随服务停止释放）。
        wake = ((android.os.PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "relquay:monitor"); wake.setReferenceCounted(false); wake.acquire();
        running = true;
        worker = Executors.newSingleThreadScheduledExecutor(); worker.scheduleWithFixedDelay(this::poll, 0, 15, TimeUnit.SECONDS);
    }
    private Notification ongoing() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pause = PendingIntent.getService(this, 1, new Intent(this, StudioNotificationService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, MONITOR).setSmallIcon(R.drawable.ic_stat_roamdeck).setContentTitle(getString(R.string.app_name) + " 提醒监听已开启").setContentText("约每 15 秒检查已选服务器 · 可随时暂停").setContentIntent(open).setOngoing(true).setSilent(true).setCategory(NotificationCompat.CATEGORY_SERVICE).addAction(0, "暂停监听", pause).build();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { prefs().edit().putBoolean("enabled", false).commit(); stopSelf(); return START_NOT_STICKY; }
        if (!prefs().getBoolean("enabled", false) || !StudioNotificationsPlugin.allowed(this)) { stopSelf(); return START_NOT_STICKY; }
        return START_STICKY;
    }
    private boolean selected(String origin) { JSONArray servers = StudioNotificationsPlugin.servers(prefs()); for (int i = 0; i < servers.length(); i++) if (origin.equals(servers.optJSONObject(i).optString("origin"))) return true; return false; }
    private void poll() {
        if (stopped) return;
        if (!prefs().getBoolean("enabled", false) || !StudioNotificationsPlugin.allowed(this)) { stopSelf(); return; }
        JSONArray servers = StudioNotificationsPlugin.servers(prefs());
        for (int i = 0; i < servers.length() && !stopped; i++) {
            JSONObject server = servers.optJSONObject(i); if (server == null) continue; String origin = server.optString("origin"), name = server.optString("name", "服务器");
            try {
                String token = StudioCredentialsPlugin.readToken(this, origin);
                if (token.isEmpty()) { prefs().edit().putString("error:" + origin, "请先登录该服务器").apply(); continue; }
                boolean first = !prefs().contains("cursor:" + origin); long cursor = prefs().getLong("cursor:" + origin, 0);
                long since = prefs().getLong("since:" + origin, System.currentTimeMillis());
                if (first && !prefs().contains("since:" + origin)) prefs().edit().putLong("since:" + origin, since).commit();
                for (int batch = 0; batch < 6 && !stopped && selected(origin); batch++) {
                    JSONObject page = request(origin, token, first ? null : cursor); if (stopped || !selected(origin)) break;
                    // A restored server may have an older sequence. Bootstrap pending items without replaying old completions.
                    if (!first && page.optBoolean("gap") && page.optLong("cursor") < cursor) { prefs().edit().remove("cursor:" + origin).putLong("since:" + origin, System.currentTimeMillis()).commit(); break; }
                    JSONArray items = page.getJSONArray("items");
                    for (int j = 0; j < items.length() && !stopped && selected(origin); j++) {
                        JSONObject item = items.getJSONObject(j); String type = item.getString("type"); boolean approval = type.equals("approval") || type.equals("question");
                        long created = 0; try { created = java.time.Instant.parse(item.optString("createdAt")).toEpochMilli(); } catch (Exception ignored) {}
                        if (item.has("resolvedAt") || item.has("readAt") || first && !approval && created < since || !(approval ? prefs().getBoolean("approvals", true) : prefs().getBoolean("completions", true))) continue;
                        // The ongoing monitor channel can remain visible while alerts
                        // are disabled. Keep the cursor until the user restores it.
                        if (manager().getNotificationChannel(ALERTS).getImportance() == NotificationManager.IMPORTANCE_NONE) throw new Exception("Alerts disabled");
                        alert(origin, name, item);
                    }
                    cursor = page.getLong("cursor"); prefs().edit().putLong("cursor:" + origin, cursor).putLong("synced:" + origin, System.currentTimeMillis()).remove("error:" + origin).commit();
                    if (first || !page.optBoolean("hasMore")) break;
                }
            } catch (Exception e) { prefs().edit().putString("error:" + origin, e instanceof LoginRequired ? "登录已过期，请重新登录" : "暂未同步，请检查连接或服务器版本").apply(); }
        }
    }
    private JSONObject request(String origin, String token, Long after) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URI(origin + "/api/notifications" + (after == null ? "" : "?after=" + after)).toURL().openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(8000); connection.setReadTimeout(8000); connection.setRequestProperty("Authorization", "Bearer " + token); connection.setRequestProperty("Accept", "application/json");
        try {
            int status = connection.getResponseCode(); if (status == 401 || status == 403) throw new LoginRequired(); if (status != 200) throw new Exception("Unavailable");
            try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int n; while ((n = stream.read(buffer)) != -1) { output.write(buffer, 0, n); if (output.size() > 512 * 1024) throw new Exception("Response too large"); } return new JSONObject(output.toString(StandardCharsets.UTF_8.name())); }
        } finally { connection.disconnect(); }
    }
    private void alert(String origin, String server, JSONObject item) throws Exception {
        String id = item.getString("id"), type = item.getString("type"), title;
        // Only a local fixed label appears on the lock screen, never server supplied content.
        switch (type) {
            case "approval": title = "AI 需要手动批准"; break;
            case "question": title = "AI 需要你的回答"; break;
            case "agent-complete": title = "AI 本轮已完成"; break;
            case "agent-ended": title = "AI 会话已结束，请查看结果"; break;
            case "agent-failed": title = "AI 轮次已中断或失败"; break;
            case "job-complete": title = "后台任务已完成"; break;
            case "job-failed": title = "后台任务失败或中断"; break;
            default: return;
        }
        Intent intent = new Intent(this, MainActivity.class).setAction(StudioNotificationsPlugin.OPEN).setData(android.net.Uri.parse("roamdeck://notice/" + id + "/" + Integer.toUnsignedString(origin.hashCode()))).putExtra("origin", origin).putExtra("eventId", id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Bundle extras = new Bundle(); extras.putString("roamdeck.origin", origin); extras.putString("roamdeck.eventId", id); extras.putString("roamdeck.type", type);
        Notification publicView = new NotificationCompat.Builder(this, ALERTS).setSmallIcon(R.drawable.ic_stat_roamdeck).setContentTitle(getString(R.string.app_name) + " 有新提醒").build();
        Notification notification = new NotificationCompat.Builder(this, ALERTS).setSmallIcon(R.drawable.ic_stat_roamdeck).setContentTitle(title).setContentText(server + " · 点击打开工作台").setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicView).setCategory(type.equals("approval") || type.equals("question") ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_STATUS).addExtras(extras).build();
        if (!stopped && selected(origin) && StudioNotificationsPlugin.allowed(this)) { manager().notify(origin + ":" + id, 1, notification); prefs().edit().putLong("lastAlert:" + origin, System.currentTimeMillis()).apply(); }
    }
    @Override public void onDestroy() { stopped = true; running = false; if (worker != null) worker.shutdownNow(); if (wake != null && wake.isHeld()) wake.release(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
    private static class LoginRequired extends Exception {}
}
