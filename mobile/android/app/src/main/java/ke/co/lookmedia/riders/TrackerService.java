package ke.co.lookmedia.riders;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service that shares the rider's GPS position with the server while they are clocked in.
 * It posts directly to POST /api/location using the WebView's session cookie and CSRF token, so it keeps
 * working with the screen off. Without a connection, positions are appended to a file and uploaded later
 * through POST /api/location/batch. It stops itself when the server says the rider is clocked out or the
 * session has ended.
 */
public class TrackerService extends Service implements LocationListener {
    static final String PREFS = "rider_tracker";
    private static final String CHANNEL = "tracking";
    private static final int NOTIF_ID = 4101;
    private static final String QUEUE_FILE = "gps-queue.jsonl";
    private static final int QUEUE_MAX = 3000;
    private static final float MAX_ACCURACY_M = 250f;

    interface Listener {
        void onPosition(JSObject data);
        void onStopped(String reason);
    }

    static volatile Listener listener;
    static volatile boolean running = false;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private LocationManager lm;
    private Location last;
    private long lastSentAt = 0;
    private long intervalMs = 15000;
    private float minDistance = 25f;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.getBoolean("enabled", false)) { stopSelf(); return START_NOT_STICKY; }
        intervalMs = Math.max(5000L, p.getLong("intervalMs", 15000L));
        minDistance = p.getFloat("minDistanceM", 25f);
        startInForeground();
        if (!running) {
            running = true;
            lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            try {
                long minTime = Math.max(3000L, intervalMs / 3);
                if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTime, 10f, this, Looper.getMainLooper());
                if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTime, 10f, this, Looper.getMainLooper());
            } catch (SecurityException e) {
                finish("Location permission was removed.");
                return START_NOT_STICKY;
            }
            io.execute(this::flushQueue);
        }
        // Restarted by Android after being killed: carry on while the rider is clocked in.
        return START_STICKY;
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while you are clocked in and sharing your location with dispatch.");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_rider)
            .setContentTitle("Rider Requests — clocked in")
            .setContentText("Sharing your location with dispatch. Clock out in the app to stop.")
            .setOngoing(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIF_ID, n);
    }

    @Override
    public void onLocationChanged(@NonNull Location loc) {
        long now = System.currentTimeMillis();
        if (loc.hasAccuracy() && loc.getAccuracy() > MAX_ACCURACY_M && last != null) return;
        if (last != null && now - lastSentAt < intervalMs && loc.distanceTo(last) < minDistance) return;
        // Prefer GPS: ignore a coarse network fix that arrives right after a good GPS fix.
        if (last != null && now - lastSentAt < intervalMs && loc.hasAccuracy() && last.hasAccuracy() && loc.getAccuracy() > last.getAccuracy() * 3) return;
        last = loc;
        lastSentAt = now;
        final JSONObject point = toJson(loc);
        io.execute(() -> deliver(point));
    }

    @Override public void onProviderEnabled(@NonNull String provider) {}
    @Override public void onProviderDisabled(@NonNull String provider) {}
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}

    private JSONObject toJson(Location loc) {
        JSONObject o = new JSONObject();
        try {
            o.put("lat", loc.getLatitude());
            o.put("lng", loc.getLongitude());
            if (loc.hasAccuracy()) o.put("accuracy", (double) loc.getAccuracy());
            if (loc.hasBearing()) o.put("heading", (double) loc.getBearing());
            if (loc.hasSpeed()) o.put("speed", loc.getSpeed() * 3.6); // km/h
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            o.put("recordedAt", f.format(new Date(loc.getTime())));
        } catch (Exception ignored) { }
        return o;
    }

    /** Sends one position; queues it when offline. Runs on the io thread. */
    private void deliver(JSONObject point) {
        boolean sent = false;
        try {
            Response r = post("/api/location", point.toString());
            if (r.code == 200) {
                sent = true;
                flushQueue();
            } else if (r.code == 409 && r.body.contains("off_shift")) {
                finish("You are clocked out.");
                return;
            } else if (r.code == 401) {
                enqueue(point);
                finish("Signed out — sign in again to resume location sharing.");
                return;
            } else if (r.code == 403 || r.code >= 500) {
                enqueue(point); // session token refresh pending, or server trouble: keep it for later
            }
            // 400 (e.g. outside Kenya): dropped on purpose.
        } catch (IOException e) {
            enqueue(point);
        }
        emit(point, sent);
    }

    private void emit(JSONObject point, boolean sent) {
        final Listener l = listener;
        if (l == null) return;
        final JSObject o = new JSObject();
        try {
            o.put("lat", point.getDouble("lat"));
            o.put("lng", point.getDouble("lng"));
            o.put("accuracy", point.optDouble("accuracy", 0));
            o.put("heading", point.has("heading") ? point.getDouble("heading") : null);
            o.put("speed", point.has("speed") ? point.getDouble("speed") / 3.6 : null);
            o.put("time", System.currentTimeMillis());
            o.put("sent", sent);
            o.put("queued", queuedCount(this));
        } catch (Exception ignored) { }
        main.post(() -> l.onPosition(o));
    }

    // ---------- offline queue (one JSON object per line) ----------
    private synchronized void enqueue(JSONObject point) {
        List<String> lines = readQueue(this);
        lines.add(point.toString());
        while (lines.size() > QUEUE_MAX) lines.remove(0);
        writeQueue(lines);
    }

    private synchronized void flushQueue() {
        List<String> lines = readQueue(this);
        while (!lines.isEmpty()) {
            int n = Math.min(400, lines.size());
            JSONArray arr = new JSONArray();
            for (int i = 0; i < n; i++) {
                try { arr.put(new JSONObject(lines.get(i))); } catch (Exception ignored) { }
            }
            try {
                Response r = post("/api/location/batch", new JSONObject().put("points", arr).toString());
                if (r.code != 200) return;
            } catch (Exception e) {
                return;
            }
            lines = new ArrayList<>(lines.subList(n, lines.size()));
            writeQueue(lines);
        }
    }

    static int queuedCount(Context ctx) { return readQueue(ctx).size(); }

    private static List<String> readQueue(Context ctx) {
        List<String> out = new ArrayList<>();
        File f = new File(ctx.getFilesDir(), QUEUE_FILE);
        if (!f.exists()) return out;
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) if (!line.isEmpty()) out.add(line);
        } catch (IOException ignored) { }
        return out;
    }

    private void writeQueue(List<String> lines) {
        File f = new File(getFilesDir(), QUEUE_FILE);
        try (FileWriter w = new FileWriter(f, false)) {
            for (String l : lines) { w.write(l); w.write('\n'); }
        } catch (IOException ignored) { }
    }

    // ---------- HTTP ----------
    private static final class Response {
        final int code; final String body;
        Response(int code, String body) { this.code = code; this.body = body; }
    }

    private Response post(String path, String json) throws IOException {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String server = p.getString("serverUrl", "");
        if (server.isEmpty()) throw new IOException("no server");
        URL url = new URL(server + path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Origin", server);
            c.setRequestProperty("X-CSRF-Token", p.getString("csrf", ""));
            String cookie = CookieManager.getInstance().getCookie(server);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) > 0 && sb.length() < 8192) sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                is.close();
            }
            return new Response(code, sb.toString());
        } finally {
            c.disconnect();
        }
    }

    private void finish(String reason) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
        final Listener l = listener;
        if (l != null) main.post(() -> l.onStopped(reason));
        main.post(this::stopSelf);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (lm != null) lm.removeUpdates(this);
        io.shutdown();
        super.onDestroy();
    }
}
