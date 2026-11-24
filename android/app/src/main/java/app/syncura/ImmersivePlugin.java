package app.syncura;

import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hides Android's system bars while the page asks for it.
 *
 * A WebView cannot set the window's insets behaviour itself -- those flags live
 * on the Activity -- so the page toggles a single boolean here and this applies
 * it. Nothing else in the app is allowed to change it, which is why the page
 * re-asserts on focus rather than leaving it to whichever screen happened to
 * open last.
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    private boolean immersive;

    @PluginMethod
    public void setImmersive(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", false);
        immersive = Boolean.TRUE.equals(enabled);
        apply();
        call.resolve();
    }

    @PluginMethod
    public void isImmersive(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", immersive);
        call.resolve(result);
    }

    private void apply() {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (immersive) {
                /* Immersive sticky rather than transient: the bars have to stay
                   gone through a rotation and while the keyboard is up, or the
                   video the user is watching grows a status bar mid-playback. */
                window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                );
            } else {
                window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
            applyModern(window);
        });
    }

    /** Android 11+ deprecates setSystemUiVisibility in favour of the insets
     *  controller. Both are set: the flags cover older phones, the controller
     *  covers the ones where the deprecated path is only a compatibility shim. */
    private void applyModern(Window window) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        WindowInsetsController controller = window.getInsetsController();
        if (controller == null) return;
        if (immersive) {
            controller.hide(WindowInsets.Type.systemBars());
            controller.setSystemBarsBehavior(
                WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            );
        } else {
            controller.show(WindowInsets.Type.systemBars());
        }
    }

    /** Re-applies after focus returns, because Android restores the bars itself. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (immersive) apply();
    }
}