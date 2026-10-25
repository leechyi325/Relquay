package xyz.leechyi.compileverse;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;

@CapacitorPlugin(name = "StudioNotifications", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class StudioNotificationsPlugin extends Plugin {
    static final String OPEN = "xyz.leechyi.compileverse.OPEN_NOTICE";
    static SharedPreferences storage(Context context) { return context.getSharedPreferences("studio_notifications", Context.MODE_PRIVATE); }
    static boolean allowed(Context context) { return NotificationManagerCompat.from(context).areNotificationsEnabled(); }
    static JSONArray servers(SharedPreferences prefs) { try { return new JSONArray(prefs.getString("servers", "[]")); } catch (Exception ignored) { return new JSONArray(); } }
    private JSONArray checkedServers(JSArray values) throws Exception {
        JSONArray result = new JSONArray(); if (values == null || values.length() > 50) throw new Exception("请选择 1 至 50 台服务器");
        for (int i = 0; i < values.length(); i++) {
            JSONObject item = values.getJSONObject(i); String origin = item.getString("origin"); URI uri = new URI(origin);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawPath() != null && !uri.getRawPath().isEmpty()) throw new Exception("服务器需使用 HTTPS 根地址");
            String name = item.optString("name", uri.getHost());
            result.put(new JSONObject().put("origin", origin).put("name", name.substring(0, Math.min(60, name.length()))));
        }
        return result;
    }
    private JSObject snapshot() throws Exception {
        SharedPreferences prefs = storage(getContext()); JSObject result = new JSObject(); JSONArray servers = servers(prefs), health = new JSONArray(), alerts = new JSONArray();
        result.put("enabled", prefs.getBoolean("enabled", false)); result.put("running", StudioNotificationService.running); result.put("permission", allowed(getContext()));
        result.put("approvals", prefs.getBoolean("approvals", true)); result.put("completions", prefs.getBoolean("completions", true)); result.put("servers", servers);
        for (int i = 0; i < servers.length(); i++) { String origin = servers.getJSONObject(i).getString("origin"); JSONObject row = new JSONObject().put("origin", origin); long synced = prefs.getLong("synced:" + origin, 0); if (synced > 0) row.put("syncedAt", synced); String error = prefs.getString("error:" + origin, ""); if (!error.isEmpty()) row.put("error", error); health.put(row); }
        NotificationManager manager = (NotificationManager)getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        for (android.service.notification.StatusBarNotification item : manager.getActiveNotifications()) { android.os.Bundle extras = item.getNotification().extras; String event = extras.getString("roamdeck.eventId"); if (event != null) alerts.put(new JSONObject().put("eventId", event).put("origin", extras.getString("roamdeck.origin")).put("type", extras.getString("roamdeck.type"))); }
        result.put("serversStatus", health); result.put("alerts", alerts); return result;
    }
    @PluginMethod public void status(PluginCall call) { try { call.resolve(snapshot()); } catch (Exception e) { call.reject("无法读取提醒状态"); } }
    @PluginMethod public void configure(PluginCall call) {
        if (call.getBoolean("enabled", false) && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) { requestPermissionForAlias("notifications", call, "permissionResult"); return; }
        apply(call);
    }
    @PermissionCallback private void permissionResult(PluginCall call) { apply(call); }
    private void apply(PluginCall call) {
        try {
            JSONArray servers = checkedServers(call.getArray("servers")); boolean enabled = call.getBoolean("enabled", false);
            if (enabled && servers.length() == 0) { call.reject("请至少选择一台服务器"); return; }
            SharedPreferences prefs = storage(getContext());
            prefs.edit().putString("servers", servers.toString()).putBoolean("approvals", call.getBoolean("approvals", true)).putBoolean("completions", call.getBoolean("completions", true)).putBoolean("enabled", enabled && allowed(getContext())).commit();
            Intent service = new Intent(getContext(), StudioNotificationService.class);
            if (enabled && allowed(getContext())) ContextCompat.startForegroundService(getContext(), service); else getContext().stopService(service);
            call.resolve(snapshot());
        } catch (Exception e) { storage(getContext()).edit().putBoolean("enabled", false).apply(); call.reject("无法开启监听，请保持 App 在前台后重试"); }
    }
    @PluginMethod public void syncServers(PluginCall call) {
        try {
            JSONArray available = checkedServers(call.getArray("servers")), old = servers(storage(getContext())), next = new JSONArray();
            for (int i = 0; i < old.length(); i++) for (int j = 0; j < available.length(); j++) if (old.getJSONObject(i).getString("origin").equals(available.getJSONObject(j).getString("origin"))) next.put(available.getJSONObject(j));
            SharedPreferences prefs = storage(getContext()); prefs.edit().putString("servers", next.toString()).commit();
            if (next.length() == 0) { prefs.edit().putBoolean("enabled", false).apply(); getContext().stopService(new Intent(getContext(), StudioNotificationService.class)); }
            call.resolve();
        } catch (Exception e) { call.reject("无法同步监听服务器"); }
    }
    private JSObject peek(Intent intent) {
        JSObject value = new JSObject(); if (intent != null && OPEN.equals(intent.getAction())) { value.put("origin", intent.getStringExtra("origin")); value.put("eventId", intent.getStringExtra("eventId")); } return value;
    }
    @Override protected void handleOnNewIntent(Intent intent) { getActivity().setIntent(intent); JSObject target = peek(intent); if (target.has("eventId")) notifyListeners("opened", target, true); }
    @PluginMethod public void getPendingOpen(PluginCall call) { call.resolve(peek(getActivity().getIntent())); }
    @PluginMethod public void consumeOpen(PluginCall call) { Intent intent = getActivity().getIntent(); if (intent != null && call.getString("eventId", "").equals(intent.getStringExtra("eventId"))) { intent.setAction(Intent.ACTION_MAIN); intent.removeExtra("origin"); intent.removeExtra("eventId"); } call.resolve(); }
    @PluginMethod public void openSettings(PluginCall call) { Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName()); getActivity().startActivity(intent); call.resolve(); }
}
