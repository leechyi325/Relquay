package xyz.leechyi.compileverse;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
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
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(call.getString("url")).openConnection();
                connection.setConnectTimeout(15000); connection.setReadTimeout(60000); connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200) throw new Exception("Download failed: " + connection.getResponseCode());
                try (InputStream source = connection.getInputStream(); OutputStream destination = getContext().getContentResolver().openOutputStream(target, "w")) {
                    if (destination == null) throw new Exception("Cannot open destination");
                    byte[] buffer = new byte[65536]; int length;
                    while ((length = source.read(buffer)) != -1) destination.write(buffer, 0, length);
                }
                call.resolve();
            } catch (Exception e) { call.reject("文件保存失败", e); }
            finally { if (connection != null) connection.disconnect(); }
        });
    }
}
