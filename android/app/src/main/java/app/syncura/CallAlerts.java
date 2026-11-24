package app.syncura;

import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/**
 * Where the call preferences live, and how the native layer reads them.
 *
 * The WebView stores its settings in localStorage, which the native side cannot
 * read. So the two preferences that have to be honoured natively -- the chosen
 * ringtone and whether the phone should vibrate on a call -- are mirrored into
 * SharedPreferences by a small Capacitor plugin, and read back from here.
 *
 * Both have defaults that match the app: the system ringtone and vibration on.
 */
public final class CallAlerts {

    private static final String PREFS = "syncura_call_alerts";
    private static final String KEY_RINGTONE = "ringtone_uri";
    private static final String KEY_VIBRATE = "vibrate";
    private static final String KEY_ENABLED = "enabled";

    private CallAlerts() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The chosen sound, or the system ringtone when the user has not chosen one. */
    public static Uri ringtoneUri(Context context) {
        String stored = prefs(context).getString(KEY_RINGTONE, "");
        if (stored == null || stored.trim().isEmpty()) return null;
        try {
            return Uri.parse(stored);
        } catch (Exception error) {
            return null;
        }
    }

    public static void setRingtoneUri(Context context, String uri) {
        prefs(context).edit().putString(KEY_RINGTONE, uri == null ? "" : uri).apply();
    }

    /** Falls back to the system default sound so the ringtone is never null. */
    public static Uri effectiveRingtone(Context context) {
        Uri chosen = ringtoneUri(context);
        return chosen != null ? chosen : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    }

    public static boolean vibrationEnabled(Context context) {
        return prefs(context).getBoolean(KEY_VIBRATE, true);
    }

    public static void setVibrationEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_VIBRATE, enabled).apply();
    }

    public static boolean enabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, true);
    }

    public static void setEnabled(Context context, boolean value) {
        prefs(context).edit().putBoolean(KEY_ENABLED, value).apply();
    }

    /** Clears the call notification when the ringing ends. */
    public static void cancelCallNotification(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(42);
    }
}
