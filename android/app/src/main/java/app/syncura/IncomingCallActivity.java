package app.syncura;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The screen that takes over when a call arrives.
 *
 * A separate activity rather than a notification, because a call has to be
 * answerable from anywhere: a heads-up banner gets dismissed by a stray swipe
 * and the call then rings at nobody. This shows over the lock screen, wakes the
 * display, and offers Accept and Decline without the app having to be open.
 *
 * The UI is built in code rather than from a layout file. It is four strings and
 * two buttons, and a layout resource would have to be duplicated across every
 * density and orientation the project already carries splash art for -- for no
 * gain at this size.
 *
 * The ringtone is whatever the person picked in Settings, stored as a URI by the
 * WebView layer (see CallAlerts). That choice is honoured here without
 * allow-listing anything, so any sound in the phone's library works.
 */
public class IncomingCallActivity extends Activity {

    private static final String CHANNEL_ID = "syncura_calls";
    private static final int NOTIFICATION_ID = 42;
    private static final String ACTION_STOP = "stop";

    private Uri ringtoneUri;
    private android.media.Ringtone ringtone;
    private android.os.Vibrator vibrator;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable buzz = new Runnable() {
        @Override
        public void run() {
            vibrateOnce();
            handler.postDelayed(this, 1800);
        }
    };
    private boolean ringing = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Cancelling the ring: answered, declined, or timed out.
        if (getIntent() != null && ACTION_STOP.equals(getIntent().getAction())) {
            finish();
            return;
        }

        showOverLockScreen();
        buildUi();
        startRinging();
        postNotification();

        // A call that rings forever stops being heard. Sixty seconds matches
        // what a phone does, and the caller is told by the socket timeout anyway.
        handler.postDelayed(this::stopRinging, 60_000);
    }

    /**
     * Shows over the lock screen and wakes the display. On its own this is not
     * enough to be usable on a locked phone -- the keyguard still swallows
     * touches -- so the keyguard is dismissed too, which is why the manifest asks
     * for DISABLE_KEYGUARD. A swipe-only unlock is attempted first where the
     * system allows it.
     */
    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            );
            try {
                android.app.KeyguardManager keyguard =
                    (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
                if (keyguard != null && !keyguard.isKeyguardLocked()) {
                    keyguard.requestDismissKeyguard(this, null);
                }
            } catch (Exception error) {
                android.util.Log.w("SyncuraCall", "Could not dismiss the keyguard", error);
            }
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }
    }

    private String callerName() {
        String name = getIntent() == null ? null : getIntent().getStringExtra("caller");
        return name == null || name.trim().isEmpty() ? "your partner" : name;
    }

    private boolean isVideo() {
        String mode = getIntent() == null ? null : getIntent().getStringExtra("mode");
        return "video".equals(mode);
    }

    private String callId() {
        String id = getIntent() == null ? null : getIntent().getStringExtra("syncura_call_id");
        return id == null ? "" : id;
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(28), dp(28), dp(28), dp(34));
        root.setBackgroundColor(0xFF071214);

        android.widget.ImageView mark = new android.widget.ImageView(this);
        mark.setImageResource(R.drawable.ic_stat_syncura);
        // The launcher mark is a white silhouette on transparent, so it reads as
        // white artwork here once tinted by the system.
        mark.setColorFilter(Color.WHITE);
        root.addView(mark, new LinearLayout.LayoutParams(dp(84), dp(84)));

        TextView who = new TextView(this);
        who.setText(callerName());
        who.setTextColor(Color.WHITE);
        who.setTextSize(30);
        who.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams whoParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        whoParams.topMargin = dp(18);
        root.addView(who, whoParams);

        TextView kind = new TextView(this);
        kind.setText(isVideo() ? "Incoming video call" : "Incoming call");
        kind.setTextColor(0xB3FFFFFF);
        kind.setTextSize(15);
        kind.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams kindParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        kindParams.topMargin = dp(6);
        kindParams.bottomMargin = dp(34);
        root.addView(kind, kindParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);

        buttons.addView(callButton("Decline", 0xFF7A2320, false));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(dp(18), 1);
        buttons.addView(new View(this), gap);
        buttons.addView(callButton("Accept", 0xFF14685A, true));

        root.addView(buttons, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);
    }

    private View callButton(String label, int colour, boolean accept) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(17);
        button.setGravity(Gravity.CENTER);
        button.setBackgroundColor(colour);
        button.setPadding(dp(26), dp(18), dp(26), dp(18));
        button.setOnClickListener(view -> {
            // Accepting hands the call id to the app, which picks the parked call
            // up and negotiates; declining just tears the ring down.
            if (accept) {
                Intent open = new Intent(this, MainActivity.class);
                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                open.putExtra("syncura_call_id", callId());
                open.putExtra("mode", isVideo() ? "video" : "audio");
                open.putExtra("caller", callerName());
                open.putExtra("syncura_accept", true);
                startActivity(open);
            }
            stopRinging();
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(126), LinearLayout.LayoutParams.WRAP_CONTENT);
        button.setLayoutParams(params);
        return button;
    }

    /**
     * The chosen URI is only used if it still resolves to something the system
     * will play. A URI that has gone missing falls back to the system ringtone,
     * because a call nobody can hear is worse than one with the wrong sound.
     */
    private Uri resolveRingtone() {
        Uri chosen = CallAlerts.ringtoneUri(this);
        if (chosen != null) {
            try {
                android.media.Ringtone actual = RingtoneManager.getRingtone(this, chosen);
                if (actual != null) return chosen;
            } catch (Exception error) {
                android.util.Log.w("SyncuraCall", "Chosen ringtone is unavailable", error);
            }
        }
        return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    }

    private void startRinging() {
        if (!CallAlerts.enabled(this)) return;
        try {
            ringtoneUri = resolveRingtone();
            if (ringtoneUri != null) {
                ringtone = RingtoneManager.getRingtone(this, ringtoneUri);
                if (ringtone != null) {
                    // AudioAttributes rather than the deprecated play(): this is
                    // what routes to the ringer volume instead of media volume,
                    // which is the entire point of a call alert.
                    ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                    ringtone.play();
                }
            }
        } catch (Exception error) {
            android.util.Log.w("SyncuraCall", "Could not start the ringtone", error);
        }

        if (CallAlerts.vibrationEnabled(this)) {
            vibrator = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            handler.post(buzz);
        }
    }

    private void vibrateOnce() {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(android.os.VibrationEffect.createWaveform(new long[] {0, 700, 500}, 0));
            } else {
                vibrator.vibrate(new long[] {0, 700, 500}, 0);
            }
        } catch (Exception error) {
            android.util.Log.w("SyncuraCall", "Could not vibrate", error);
        }
    }

    private void stopRinging() {
        if (!ringing) return;
        ringing = false;
        handler.removeCallbacks(buzz);
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        } catch (Exception ignored) {
            // Closing anyway.
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {
                // Closing anyway.
            }
        }
        CallAlerts.cancelCallNotification(this);
        finish();
    }

    @Override
    public void onBackPressed() {
        // Backing out of a ringing call is a decline, not a pause.
        stopRinging();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        } catch (Exception ignored) {
            // Closing anyway.
        }
        super.onDestroy();
    }

    private void postNotification() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Incoming calls from your partner.");
            channel.enableVibration(CallAlerts.vibrationEnabled(this));
            channel.setVibrationPattern(new long[] {0, 700, 500});
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            if (ringtoneUri != null) {
                channel.setSound(ringtoneUri, new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            }
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("syncura_call_id", callId());
        open.putExtra("mode", isVideo() ? "video" : "audio");
        open.putExtra("caller", callerName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle((isVideo() ? "Video call · " : "Call · ") + callerName())
            .setContentText("Tap to open Syncura")
            .setSmallIcon(R.drawable.ic_stat_syncura)
            .setCategory(Notification.CATEGORY_CALL)
            .setPriority(Notification.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
            .build();
        manager.notify(NOTIFICATION_ID, notification);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        // Nothing to retry here: the ring is already running without the
        // permission, and VIBRATE is a normal permission granted at install.
    }

    /** Reached from the app's Settings when notifications are switched off. */
    @SuppressWarnings("unused")
    public void openNotificationSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (Exception error) {
            android.util.Log.w("SyncuraCall", "No notification settings screen available", error);
        }
    }
}