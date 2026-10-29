package xyz.leechyi.compileverse;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// 让状态栏/导航栏图标与应用主题保持对比：亮色主题用深色图标，暗色主题用浅色图标。
@CapacitorPlugin(name = "StudioTheme")
public class StudioThemePlugin extends Plugin {
    @PluginMethod public void apply(PluginCall call) {
        final boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        final int background = dark ? Color.parseColor("#12171B") : Color.parseColor("#F7F5EF");
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            window.setBackgroundDrawable(new ColorDrawable(background));
            window.setStatusBarColor(background);
            window.setNavigationBarColor(background);
            call.resolve();
        });
    }
}
