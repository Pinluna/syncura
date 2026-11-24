package app.syncura;

import android.content.Intent;

/**
 * Holds a call that arrived while the app was not on screen.
 *
 * A notification tap or a full-screen call intent can reach MainActivity before
 * the page has run, and on a cold start there is no JavaScript to call yet. So
 * the intent is parked here and the page collects it once it is loaded, instead
 * of being eval'd into a WebView that may not exist.
 */
public final class PendingCall {

    public String callId;
    public String mode;
    public String caller;

    private PendingCall() {
    }

    private static final Object LOCK = new Object();
    private static PendingCall queued;

    /** The intent is only a notification launch, not an actual call. */
    public static boolean isCallIntent(Intent intent) {
        return intent != null && intent.getStringExtra("syncura_call_id") != null;
    }

    public static void from(Intent intent) {
        if (!isCallIntent(intent)) return;
        PendingCall call = new PendingCall();
        call.callId = intent.getStringExtra("syncura_call_id");
        call.mode = intent.getStringExtra("mode");
        call.caller = intent.getStringExtra("caller");
        synchronized (LOCK) {
            queued = call;
        }
    }

    /** Returns the parked call and clears it, so a later launch does not replay it. */
    public static PendingCall take() {
        synchronized (LOCK) {
            PendingCall call = queued;
            queued = null;
            return call;
        }
    }
}