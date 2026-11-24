package app.syncura;

import android.app.Activity;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridges the WebView to the two things it cannot do on its own.
 *
 * The call preferences have to be known natively -- the ringing screen is an
 * Android activity, not part of the page -- so the page writes them here and the
 * native ringing activity reads them back.
 *
 * The ringtone picker is the system picker rather than a file browser, so
 * everything in the phone's library shows up, including ringtones the user
 * downloaded. Nothing is allow-listed on this side.
 */
@CapacitorPlugin(name = "CallAlerts")
public class CallAlertsPlugin extends Plugin {

    private static final int PICK_RINGTONE = 9001;

    @PluginMethod
    public void getPreferences(PluginCall call) {
        Uri chosen = CallAlerts.ringtoneUri(getContext());
        Uri effective = CallAlerts.effectiveRingtone(getContext());
        JSObject result = new JSObject();
        result.put("enabled", CallAlerts.enabled(getContext()));
        result.put("vibrate", CallAlerts.vibrationEnabled(getContext()));
        result.put("ringtoneUri", chosen == null ? "" : chosen.toString());
        result.put("systemRingtoneName", titleOf(effective));
        call.resolve(result);
    }

    private String titleOf(Uri uri) {
        if (uri == null) return "";
        try {
            android.media.Ringtone ringtone = RingtoneManager.getRingtone(getContext(), uri);
            return ringtone == null ? "" : String.valueOf(ringtone.getTitle(getContext()));
        } catch (Exception error) {
            return "";
        }
    }

    @PluginMethod
    public void setVibrate(PluginCall call) {
        Boolean value = call.getBoolean("enabled");
        if (value == null) {
            call.reject("enabled is required");
            return;
        }
        CallAlerts.setVibrationEnabled(getContext(), value);
        call.resolve();
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean value = call.getBoolean("enabled");
        if (value == null) {
            call.reject("enabled is required");
            return;
        }
        CallAlerts.setEnabled(getContext(), value);
        call.resolve();
    }

    @PluginMethod
    public void pickRingtone(PluginCall call) {
        // Remembered so the picker comes back to this call's result.
        pluginCall = call;
        try {
            Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_RINGTONE);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);
            Uri current = CallAlerts.ringtoneUri(getContext());
            if (current != null) intent.putExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, current);
            startActivityForResult(call, intent, "ringtonePicked");
        } catch (Exception error) {
            call.reject("This phone has no ringtone picker available", error);
        }
    }

    /** The system picker result. A cancelled pick resolves with an empty URI rather
     *  than an error, so the WebView can simply leave the current choice alone. */
    @PluginMethod
    public void ringtonePicked(PluginCall call, Intent intent) {
        pluginCall = null;
        Uri uri = intent == null ? null : intent.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
        if (uri == null) {
            call.resolve(new JSObject());
            return;
        }
        CallAlerts.setRingtoneUri(getContext(), uri.toString());
        JSObject result = new JSObject();
        result.put("ringtoneUri", uri.toString());
        result.put("ringtoneName", titleOf(uri));
        call.resolve(result);
    }

    /** Opens Android's own notification settings for this app, for the permission. */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            Activity activity = getActivity();
            if (activity == null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } else {
                activity.startActivity(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("This phone has no notification settings screen", error);
        }
    }

    /** Starts or stops the process keep-alive that lets messages and calls in. */
    @PluginMethod
    public void setKeepAlive(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", true);
        if (Boolean.TRUE.equals(enabled)) {
            RealtimeService.start(getContext());
        } else {
            RealtimeService.stop(getContext());
        }
        call.resolve();
    }
}