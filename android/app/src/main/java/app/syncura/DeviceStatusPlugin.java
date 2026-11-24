package app.syncura;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Looper;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;
import com.google.android.gms.location.DetectedActivity;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

@CapacitorPlugin(
    name = "DeviceStatus",
    permissions = {
        @Permission(alias = "activityRecognition", strings = { Manifest.permission.ACTIVITY_RECOGNITION }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION
        })
    }
)
public class DeviceStatusPlugin extends Plugin implements SensorEventListener {
    private static final String PREFS = "syncura.deviceStatus";
    private static final String UNKNOWN_ACTIVITY = "unknown";
    private static DeviceStatusPlugin activePlugin;

    private SensorManager sensorManager;
    private Sensor stepCounter;
    private ActivityRecognitionClient activityClient;
    private FusedLocationProviderClient locationClient;
    private LocationCallback locationCallback;
    private android.app.PendingIntent activityPendingIntent;
    private boolean locationSharing;
    private boolean trackingStarted;

    @Override
    public void load() {
        activePlugin = this;
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        stepCounter = sensorManager == null ? null : sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        activityClient = ActivityRecognition.getClient(getContext());
        locationClient = LocationServices.getFusedLocationProviderClient(getContext());
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location location = result.getLastLocation();
                if (location == null) return;

                SharedPreferences.Editor editor = prefs().edit();
                if (location.hasSpeed()) editor.putFloat("speedMs", Math.max(0, location.getSpeed()));
                else editor.remove("speedMs");
                if (locationSharing) {
                    editor.putFloat("latitude", (float) location.getLatitude());
                    editor.putFloat("longitude", (float) location.getLongitude());
                    if (location.hasAccuracy()) editor.putFloat("accuracyM", location.getAccuracy());
                }
                editor.putLong("locationUpdatedAt", System.currentTimeMillis()).apply();
                notifyListeners("status", getStatus());
            }
        };
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        locationSharing = call.getBoolean("shareLocation", false);
        if (!locationSharing) {
            prefs().edit().remove("latitude").remove("longitude").remove("accuracyM").apply();
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasActivityPermission()) {
            requestPermissionForAlias("activityRecognition", call, "activityPermissionCallback");
            return;
        }
        requestLocationPermissionIfNeeded(call);
    }

    @PermissionCallback
    private void activityPermissionCallback(PluginCall call) {
        requestLocationPermissionIfNeeded(call);
    }

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        beginTracking(call);
    }

    private void requestLocationPermissionIfNeeded(PluginCall call) {
        if (!hasLocationPermission()) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
            return;
        }
        beginTracking(call);
    }

    private void beginTracking(PluginCall call) {
        if (trackingStarted) {
            call.resolve(getStatus());
            return;
        }
        startStepCounter();
        startActivityRecognition();
        startLocationUpdates();
        trackingStarted = true;
        JSObject result = getStatus();
        result.put("stepSensorAvailable", stepCounter != null);
        result.put("activityPermission", hasActivityPermission());
        result.put("locationPermission", hasLocationPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void setLocationSharing(PluginCall call) {
        locationSharing = call.getBoolean("enabled", false);
        if (!locationSharing) {
            prefs().edit().remove("latitude").remove("longitude").remove("accuracyM").apply();
        }
        notifyListeners("status", getStatus());
        call.resolve(getStatus());
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback)
                .addOnFailureListener(error -> notifyError(error));
        }
        if (activityPendingIntent != null) {
            activityClient.removeActivityUpdates(activityPendingIntent)
                .addOnFailureListener(error -> notifyError(error));
        }
        trackingStarted = false;
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = getStatus();
        result.put("stepSensorAvailable", stepCounter != null);
        result.put("activityPermission", hasActivityPermission());
        result.put("locationPermission", hasLocationPermission());
        call.resolve(result);
    }

    private void startStepCounter() {
        if (sensorManager == null || stepCounter == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasActivityPermission()) return;
        sensorManager.registerListener(this, stepCounter, SensorManager.SENSOR_DELAY_NORMAL);
    }

    private void startActivityRecognition() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasActivityPermission()) return;
        Intent intent = new Intent(getContext(), ActivityUpdateReceiver.class);
        int flags = PendingIntentFlags.flags();
        activityPendingIntent = android.app.PendingIntent.getBroadcast(
            getContext(),
            13871,
            intent,
            flags
        );
        activityClient.requestActivityUpdates(5000, activityPendingIntent)
            .addOnFailureListener(error -> notifyError(error));
    }

    private void startLocationUpdates() {
        if (!hasLocationPermission()) return;
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5000)
            .setMinUpdateIntervalMillis(2500)
            .build();
        try {
            locationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
                .addOnFailureListener(error -> notifyError(error));
        } catch (SecurityException error) {
            notifyError(error);
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_STEP_COUNTER || event.values.length == 0) return;
        float totalSinceBoot = event.values[0];
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(new Date());
        SharedPreferences preferences = prefs();
        String savedDay = preferences.getString("stepsDay", "");
        float baseline = preferences.getFloat("stepsBaseline", -1);
        if (!today.equals(savedDay) || baseline < 0 || totalSinceBoot < baseline) {
            baseline = totalSinceBoot;
            preferences.edit().putString("stepsDay", today).putFloat("stepsBaseline", baseline).apply();
        }
        int steps = Math.max(0, Math.round(totalSinceBoot - baseline));
        preferences.edit().putInt("stepsToday", steps).apply();
        notifyListeners("status", getStatus());
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    @Override
    protected void handleOnDestroy() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (locationClient != null && locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
        }
        if (activePlugin == this) activePlugin = null;
        trackingStarted = false;
        super.handleOnDestroy();
    }

    static void saveDetectedActivity(Context context, DetectedActivity activity) {
        if (activity == null || activity.getConfidence() < 50) return;
        String value;
        switch (activity.getType()) {
            case DetectedActivity.IN_VEHICLE:
                value = "driving";
                break;
            case DetectedActivity.WALKING:
            case DetectedActivity.RUNNING:
                value = "walking";
                break;
            case DetectedActivity.STILL:
                value = "idle";
                break;
            default:
                return;
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("activity", value)
            .putLong("activityUpdatedAt", System.currentTimeMillis())
            .apply();
        if (activePlugin != null) activePlugin.notifyListeners("status", activePlugin.getStatus());
    }

    private boolean hasActivityPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLocationPermission() {
        return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED ||
            ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private JSObject getStatus() {
        SharedPreferences preferences = prefs();
        JSObject result = new JSObject();
        long now = System.currentTimeMillis();
        long activityAt = preferences.getLong("activityUpdatedAt", 0);
        result.put("activity",
            now - activityAt > 30 * 60_000L ? UNKNOWN_ACTIVITY : preferences.getString("activity", UNKNOWN_ACTIVITY));
        result.put("batteryLevel", JSONObject.NULL);
        result.put("isCharging", JSONObject.NULL);
        long locationAt = preferences.getLong("locationUpdatedAt", 0);
        boolean recentLocation = now - locationAt <= 20_000L;
        result.put("speedMs",
            recentLocation && preferences.contains("speedMs") ? preferences.getFloat("speedMs", 0) : JSONObject.NULL);
        result.put("stepsToday", preferences.contains("stepsToday") ? preferences.getInt("stepsToday", 0) : JSONObject.NULL);
        result.put("latitude", locationSharing && preferences.contains("latitude") ? preferences.getFloat("latitude", 0) : JSONObject.NULL);
        result.put("longitude", locationSharing && preferences.contains("longitude") ? preferences.getFloat("longitude", 0) : JSONObject.NULL);
        result.put("accuracyM", locationSharing && preferences.contains("accuracyM") ? preferences.getFloat("accuracyM", 0) : JSONObject.NULL);
        result.put("updatedAt", System.currentTimeMillis());

        Intent battery = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) result.put("batteryLevel", Math.round(level * 100f / scale));
            int state = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            if (state >= 0) {
                result.put("isCharging",
                    state == BatteryManager.BATTERY_STATUS_CHARGING ||
                    state == BatteryManager.BATTERY_STATUS_FULL
                );
            }
        }
        return result;
    }

    private void notifyError(Exception error) {
        JSObject detail = new JSObject();
        detail.put("message", error.getMessage() == null ? "Device status tracking failed" : error.getMessage());
        notifyListeners("error", detail);
    }

    private static final class PendingIntentFlags {
        static int flags() {
            return android.app.PendingIntent.FLAG_UPDATE_CURRENT |
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? android.app.PendingIntent.FLAG_IMMUTABLE : 0);
        }
    }
}
