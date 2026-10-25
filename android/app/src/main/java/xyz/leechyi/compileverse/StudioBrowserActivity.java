package xyz.leechyi.compileverse;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.view.ViewGroup;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** First-party manager in a separate WebView, with no Capacitor/credential bridge. */
public class StudioBrowserActivity extends Activity {
    private WebView view;
    private ValueCallback<Uri[]> chooser;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra("url");
        if (url == null || !"https".equals(Uri.parse(url).getScheme())) { finish(); return; }
        Uri initial = Uri.parse(url);
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setBackgroundColor(Color.rgb(247,242,232));
        ViewCompat.setOnApplyWindowInsetsListener(layout, (v, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        LinearLayout bar = new LinearLayout(this); bar.setPadding(12, 20, 12, 4);
        Button back = new Button(this); back.setText("返回"); back.setOnClickListener(v -> finish());
        TextView title = new TextView(this); title.setText("服务器文件管理"); title.setTextColor(Color.rgb(41,61,80)); title.setTextSize(16); title.setGravity(17);
        bar.addView(back); bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1)); layout.addView(bar);
        view = new WebView(this); view.getSettings().setJavaScriptEnabled(true); view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setAllowFileAccess(false); view.getSettings().setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                Uri next = request.getUrl();
                if ("https".equals(next.getScheme()) && initial.getHost().equals(next.getHost()) && initial.getPort() == next.getPort()) return false;
                if ("https".equals(next.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, next)); return true;
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null); chooser = callback;
                try { startActivityForResult(params.createIntent(), 71); return true; }
                catch (Exception e) { chooser = null; return false; }
            }
        });
        layout.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1)); setContentView(layout); view.loadUrl(url);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 71 && chooser != null) { chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); chooser = null; }
    }
    @Override public void onBackPressed() { if (view != null && view.canGoBack()) view.goBack(); else finish(); }
    @Override protected void onDestroy() { if (view != null) view.destroy(); if (chooser != null) chooser.onReceiveValue(null); super.onDestroy(); }
}
