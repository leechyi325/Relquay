package xyz.leechyi.compileverse;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "StudioFiles")
public class StudioFilesPlugin extends Plugin {
    private boolean valid(String url) {
        try { URL value = new URL(url); return value.getProtocol().equals("https") && value.getUserInfo() == null; }
        catch (Exception e) { return false; }
    }
    @PluginMethod public void openManager(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !valid(url)) { call.reject("Invalid HTTPS URL"); return; }
        Intent intent = new Intent(getContext(), StudioBrowserActivity.class);
        intent.putExtra("url", url); getActivity().startActivity(intent); call.resolve();
    }
    @PluginMethod public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !valid(url)) { call.reject("Invalid HTTPS URL"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("filename", "download.bin"));
        startActivityForResult(call, intent, "destination");
    }
    @ActivityCallback private void destination(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("已取消保存"); return; }
        Uri target = result.getData().getData();
        getBridge().execute(() -> {
            String address = call.getString("url");
            long total = -1, done = 0, lastEmit = 0;
            int failures = 0;
            try (OutputStream destination = getContext().getContentResolver().openOutputStream(target, "w")) {
                if (destination == null) throw new Exception("Cannot open destination");
                // 断线时从已写入的位置续传，最多重试 8 次；完成后核对长度，避免静默截断。
                while (total < 0 || done < total) {
                    HttpsURLConnection connection = null;
                    try {
                        connection = (HttpsURLConnection) new URL(address).openConnection();
                        connection.setConnectTimeout(15000); connection.setReadTimeout(30000); connection.setInstanceFollowRedirects(false);
                        if (done > 0) connection.setRequestProperty("Range", "bytes=" + done + "-");
                        int code = connection.getResponseCode();
                        if (done > 0 ? code != 206 : code != 200) throw new Exception("Download failed: " + code);
                        if (total < 0) total = connection.getContentLengthLong();
                        try (InputStream source = connection.getInputStream()) {
                            byte[] buffer = new byte[65536]; int length;
                            while ((length = source.read(buffer)) != -1) {
                                destination.write(buffer, 0, length); done += length;
                                long now = System.currentTimeMillis();
                                if (now - lastEmit > 250) { lastEmit = now; progress(done, total); }
                            }
                        }
                        if (total < 0) break;
                        if (done < total) throw new java.io.IOException("Connection closed early");
                    } catch (java.io.IOException e) {
                        if (++failures > 8) throw e;
                        Thread.sleep(Math.min(5000, 500L * failures));
                    } finally { if (connection != null) connection.disconnect(); }
                }
                destination.flush();
                progress(done, done);
                call.resolve();
            } catch (Exception e) {
                try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), target); } catch (Exception ignored) {}
                call.reject("文件下载中断（已传 " + done + " 字节），请检查网络后重试", e);
            }
        });
    }
    private void progress(long done, long total) {
        JSObject data = new JSObject(); data.put("done", done); data.put("total", total); notifyListeners("downloadProgress", data);
    }
}
