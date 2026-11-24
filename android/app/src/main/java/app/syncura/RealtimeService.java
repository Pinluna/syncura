package app.syncura;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the app's process alive while it is in the background so the realtime
 * socket stays connected and a message or a call still arrives.
 *
 * Chat messages and calls travel over a Socket.IO connection rather than a push
 * service, so nothing arrives while the process is dead. Declaring a foreground
 * service is what keeps Android from reclaiming that process in the background,
 * which means the connection survives with the app closed.
 *
 * The notification is deliberately the lowest-importance channel Android offers
 * and carries no behaviour worth interrupting anyone for: it exists to hold the
 * process, not to be read.
 */
public class RealtimeService extends Service {

    public static final String CHANNEL_ID = "syncura_connection";
    public static final int NOTIFICATION_ID = 1;

    /** Starts the service and puts it in the foreground. */
    public static void start(Context context) {
        Intent intent = new Intent(context, RealtimeService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception error) {
            // A device that refuses foreground services (some OEM builds, or a
            // background start restriction) must not take the app down with it.
            // The socket still works while the app is open; this only extends
            // how long it survives.
            android.util.Log.w("SyncuraRealtime", "Could not start the keep-alive service", error);
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, RealtimeService.class));
        } catch (Exception error) {
            android.util.Log.w("SyncuraRealtime", "Could not stop the keep-alive service", error);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startInForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Also promote here rather than only in onCreate: a restarted service has
        // to re-post its notification within five seconds or the system kills it.
        startInForeground();
        // START_STICKY so Android brings the service back if it is reclaimed
        // under memory pressure while the app is still expected to be reachable.
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Syncura connection",
            NotificationManager.IMPORTANCE_MIN
        );
        channel.setDescription("Keeps Syncura reachable for messages and calls while it is closed.");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void startInForeground() {
        Notification notification = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception error) {
            android.util.Log.w("SyncuraRealtime", "Could not enter the foreground", error);
        }
    }

    private Notification buildNotification() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent contentIntent = null;
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            contentIntent = PendingIntent.getActivity(this, 0, launch, flags);
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setContentTitle("Syncura")
            .setContentText("Connected — messages and calls can reach you")
            .setSmallIcon(R.drawable.ic_stat_syncura)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(Notification.PRIORITY_MIN)
            .setCategory(Notification.CATEGORY_SERVICE);
        if (contentIntent != null) builder.setContentIntent(contentIntent);
        return builder.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}