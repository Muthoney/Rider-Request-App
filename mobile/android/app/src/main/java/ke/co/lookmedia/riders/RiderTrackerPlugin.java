package ke.co.lookmedia.riders;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * JavaScript bridge for background rider tracking.
 *   start({ serverUrl, csrf, intervalMs, minDistanceM })  starts the foreground location service
 *   stop()                                                stops it
 *   updateSession({ csrf })                               new CSRF token after a fresh sign-in
 *   status()                                              { running, queued }
 * Events: "position" { lat, lng, accuracy, heading, speed, time, sent, queued }, "stopped" { reason }.
 */
@CapacitorPlugin(
    name = "RiderTracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class RiderTrackerPlugin extends Plugin {

    @Override
    public void load() {
        TrackerService.listener = new TrackerService.Listener() {
            @Override
            public void onPosition(JSObject data) { notifyListeners("position", data); }

            @Override
            public void onStopped(String reason) {
                JSObject o = new JSObject();
                o.put("reason", reason);
                notifyListeners("stopped", o);
            }
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission is required.", "NOT_AUTHORIZED");
            return;
        }
        String serverUrl = call.getString("serverUrl");
        if (serverUrl == null || !(serverUrl.startsWith("https://") || serverUrl.startsWith("http://localhost") || serverUrl.startsWith("http://127.0.0.1"))) {
            call.reject("serverUrl must be the app's HTTPS address.");
            return;
        }
        Context ctx = getContext();
        prefs().edit()
            .putString("serverUrl", serverUrl.replaceAll("/+$", ""))
            .putString("csrf", call.getString("csrf", ""))
            .putLong("intervalMs", call.getLong("intervalMs", 15000L))
            .putFloat("minDistanceM", call.getFloat("minDistanceM", 25f))
            .putBoolean("enabled", true)
            .apply();
        ContextCompat.startForegroundService(ctx, new Intent(ctx, TrackerService.class));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("enabled", false).apply();
        getContext().stopService(new Intent(getContext(), TrackerService.class));
        call.resolve();
    }

    @PluginMethod
    public void updateSession(PluginCall call) {
        prefs().edit().putString("csrf", call.getString("csrf", "")).apply();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", TrackerService.running);
        o.put("queued", TrackerService.queuedCount(getContext()));
        call.resolve(o);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
    }
}
