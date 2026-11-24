package app.syncura;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeviceStatusPlugin.class);
        registerPlugin(CallAlertsPlugin.class);
        registerPlugin(ImmersivePlugin.class);
        super.onCreate(savedInstanceState);

        /* Media and video calls take over the whole screen. The WebView hides the
           system bars for exactly as long as one of those surfaces is open (see
           immersive.ts), and keeps them hidden by re-asserting on focus: Android
           restores the bars after things it does not know about -- a dialog, the
           keyboard, a rotation -- and a video that suddenly grows a status bar is
           not the fullscreen that was asked for. */
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // A call may have launched the app. Park it for the page rather than
        // eval'ing into a WebView that is not ready yet.
        PendingCall.from(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        if (!PendingCall.isCallIntent(intent)) return;
        PendingCall.from(intent);
        // The page is running in this case, so it can be told straight away.
        deliverPendingCall();
    }

    private void deliverPendingCall() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().post(() -> {
            PendingCall call = PendingCall.take();
            if (call == null) return;
            StringBuilder script = new StringBuilder();
            script.append("window.__syncuraIncomingCall && window.__syncuraIncomingCall({");
            script.append("callId:").append(quote(call.callId)).append(",");
            script.append("mode:").append(quote(call.mode)).append(",");
            script.append("caller:").append(quote(call.caller));
            script.append("})");
            getBridge().getWebView().evaluateJavascript(script.toString(), null);
        });
    }

    private static String quote(String value) {
        if (value == null) return "null";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus || Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        // Lets the page re-hide the bars after Android put them back, and drains
        // any call that arrived before the page was listening.
        getBridge().getWebView().post(() -> {
            getBridge().getWebView().evaluateJavascript(
                "window.__syncuraSyncImmersive && window.__syncuraSyncImmersive()", null);
            deliverPendingCall();
        });
    }
}

