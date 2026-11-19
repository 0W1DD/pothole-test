package com.gimmegimme.pothole;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.*;
import android.media.*;
import android.os.*;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** User-started foreground location service. Does not depend on a living Activity or WebView. */
public class NearbyAlertService extends Service implements LocationListener {
    private static final String TRACKING = "pothole_tracking_v1", WARNINGS = "pothole_nearby_v1";
    private static final String STOP = "com.gimmegimme.pothole.STOP_NEARBY";
    private static final int ONGOING_ID = 7101, WARNING_ID = 7102;
    private static NearbyAlertService instance;
    private static String lastMessage = "안내가 꺼져 있습니다.";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final NearbyAlertPolicy policy = new NearbyAlertPolicy();
    private LocationManager locations;
    private NotificationManager notices;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private TextToSpeech tts;
    private boolean ttsReady, running, fetching, voice = true;
    private int radius = 200;
    private String endpoint, publicKey;
    private String dataStatus = "주변 포트홀 정보를 기다리고 있습니다.", voiceStatus = "음성 엔진 준비 중";
    private Location fix, queryCenter;
    private List<Point> points = new ArrayList<>();
    private long lastAttempt, lastSuccess;
    private double queryRange = 2000;
    private volatile HttpURLConnection activeRequest;
    // 운행 중 내 위치 → gps_logs (라즈베리파이 블랙박스가 충격 시각 위치를 찾을 때 씀)
    private static final long UPLOAD_EVERY_MS = 2000, GPS_FAST_MS = 1000, GPS_NORMAL_MS = 5000;
    private static final float UPLOAD_MAX_ACCURACY_M = 30f;
    private final ExecutorService uploadIo = Executors.newSingleThreadExecutor();
    private boolean upload, uploading;
    private long lastUploadedFixNanos, uploadCount;
    private String uploadStatus = "";

    private static final class Point {
        final String id;
        final double latitude, longitude;
        Point(String id, double latitude, double longitude) {
            this.id = id; this.latitude = latitude; this.longitude = longitude;
        }
    }

    public static JSObject snapshot(Context context) {
        JSObject result = new JSObject();
        NearbyAlertService service = instance;
        boolean active = service != null && service.running;
        result.put("running", active);
        result.put("message", active ? service.message() : lastMessage);
        result.put("radius", active ? service.radius : 200);
        result.put("voice", active && service.voice);
        result.put("voiceStatus", active ? service.voiceStatus : "");
        result.put("records", active ? service.points.size() : 0);
        result.put("upload", active && service.upload);
        result.put("uploadCount", active ? service.uploadCount : 0);
        result.put("uploadStatus", active ? service.uploadStatus : "");
        result.put("notificationsEnabled", androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("warningChannelEnabled", Build.VERSION.SDK_INT < 26 ||
                context.getSystemService(NotificationManager.class).getNotificationChannel(WARNINGS) == null ||
                context.getSystemService(NotificationManager.class).getNotificationChannel(WARNINGS).getImportance() != NotificationManager.IMPORTANCE_NONE);
        return result;
    }

    public static void stopRunning(Context context) {
        if (instance != null) instance.finish("안내를 중지했습니다.");
        else context.stopService(new Intent(context, NearbyAlertService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        locations = getSystemService(LocationManager.class);
        notices = getSystemService(NotificationManager.class);
        audio = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ongoing = new NotificationChannel(TRACKING, "주변 포트홀 안내 실행 상태", NotificationManager.IMPORTANCE_LOW);
            ongoing.setSound(null, null);
            notices.createNotificationChannel(ongoing);
            NotificationChannel alerts = new NotificationChannel(WARNINGS, "주변 포트홀 접근 알림", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("설정 거리 안의 포트홀을 알립니다.");
            alerts.enableVibration(true);
            notices.createNotificationChannel(alerts);
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @SuppressWarnings("deprecation")
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            finish("안내를 중지했습니다."); return START_NOT_STICKY;
        }
        ResultReceiver result = intent.getParcelableExtra("result");
        try {
            radius = intent.getIntExtra("radius", 200);
            if (radius < 50 || radius > 1000) throw new IllegalArgumentException("안내 거리가 올바르지 않습니다.");
            voice = intent.getBooleanExtra("voice", true);
            boolean wantUpload = intent.getBooleanExtra("upload", false);
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("정확한 위치 권한을 허용하세요.");
            if (!androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled())
                throw new SecurityException("알림 권한을 허용하세요.");
            if (Build.VERSION.SDK_INT >= 26 && notices.getNotificationChannel(WARNINGS).getImportance() == NotificationManager.IMPORTANCE_NONE)
                throw new IllegalStateException("앱 알림 설정에서 주변 포트홀 접근 알림을 켜 주세요.");
            if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING_ID, ongoing("GPS 위치를 확인하고 있습니다."), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(ONGOING_ID, ongoing("GPS 위치를 확인하고 있습니다."));
            if (!running) {
                loadConfiguration();
                running = true;
                upload = wantUpload;
                requestUpdates();
                initializeSpeech();
                main.post(tick);
                main.post(uploader);
            } else if (upload != wantUpload) {
                upload = wantUpload;                     // '설정 적용': GPS 주기만 바꿈
                locations.removeUpdates(this);
                requestUpdates();
            }
            if (!upload) uploadStatus = "";
            if (!voice && tts != null) { tts.stop(); abandonFocus(); }
            if (result != null) result.send(0, Bundle.EMPTY);
        } catch (Exception error) {
            String message = error.getMessage() == null ? "안내 시작 실패" : error.getMessage();
            if (result != null) { Bundle data = new Bundle(); data.putString("error", message); result.send(1, data); }
            finish(message);
        }
        // Never restart location silently after a process kill/reboot; the user starts from a visible screen.
        return START_NOT_STICKY;
    }

    @SuppressWarnings("MissingPermission")
    private void requestUpdates() {
        long every = upload ? GPS_FAST_MS : GPS_NORMAL_MS;
        locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, every, 0, this, Looper.getMainLooper());
        if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
            locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, GPS_NORMAL_MS, 0, this, Looper.getMainLooper());
    }

    /** 2초마다 가장 최근 GPS 위치(정확도 30m 이내, 새 위치일 때만)를 gps_logs 에 올림. 실패하면 그 위치는 버림(실시간용). */
    private final Runnable uploader = new Runnable() {
        @Override public void run() {
            if (!running) return;
            main.postDelayed(this, UPLOAD_EVERY_MS);
            if (!upload || uploading || fix == null) return;
            if (!LocationManager.GPS_PROVIDER.equals(fix.getProvider())) return;
            if (!fix.hasAccuracy() || fix.getAccuracy() > UPLOAD_MAX_ACCURACY_M) { uploadStatus = "GPS 정확도 기다리는 중"; return; }
            long age = (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1000000;
            if (age > 5000 || fix.getElapsedRealtimeNanos() == lastUploadedFixNanos) return;
            final Location sent = new Location(fix);
            lastUploadedFixNanos = sent.getElapsedRealtimeNanos();
            uploading = true;
            uploadIo.execute(() -> {
                String error = null;
                try {
                    JSONObject row = new JSONObject();
                    row.put("lat", Math.round(sent.getLatitude() * 1e6) / 1e6);
                    row.put("lon", Math.round(sent.getLongitude() * 1e6) / 1e6);
                    HttpURLConnection connection = (HttpURLConnection) new URL(endpoint + "/rest/v1/gps_logs").openConnection();
                    try {
                        connection.setConnectTimeout(4000); connection.setReadTimeout(4000);
                        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
                        connection.setRequestMethod("POST"); connection.setDoOutput(true);
                        connection.setRequestProperty("apikey", publicKey);
                        connection.setRequestProperty("Content-Type", "application/json");
                        connection.setRequestProperty("Prefer", "return=minimal");
                        try (OutputStream out = connection.getOutputStream()) { out.write(row.toString().getBytes(StandardCharsets.UTF_8)); }
                        int status = connection.getResponseCode();
                        if (status < 200 || status >= 300) error = "HTTP " + status;
                    } finally { connection.disconnect(); }
                } catch (Exception e) { error = e.getMessage() == null ? "연결 실패" : e.getMessage(); }
                final String failure = error;
                main.post(() -> {
                    uploading = false;
                    if (!running) return;
                    if (failure == null) { uploadCount++; uploadStatus = "위치 전송 " + uploadCount + "회"; }
                    else { uploadStatus = "위치 전송 실패 · 인터넷 확인"; android.util.Log.w("NearbyAlerts", "gps_logs: " + failure); }
                });
            });
        }
    };

    private void loadConfiguration() throws Exception {
        try (InputStream input = getAssets().open("public/nearby-alert-config.json")) {
            JSONObject config = new JSONObject(new String(BlackboxHttpPolicy.read(input, 16384, Long.MAX_VALUE), StandardCharsets.UTF_8));
            URL url = new URL(config.getString("url"));
            if (!"https".equals(url.getProtocol()) || !url.getHost().endsWith(".supabase.co")
                    || url.getUserInfo() != null || url.getPort() != -1 || !url.getPath().isEmpty())
                throw new IllegalArgumentException("주변 포트홀 서버 설정을 확인하세요.");
            endpoint = url.toString();
            publicKey = config.getString("key");
            if (!publicKey.startsWith("sb_publishable_")) throw new IllegalArgumentException("서버 공개 publishable 키가 필요합니다.");
        }
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            if (ContextCompat.checkSelfPermission(NearbyAlertService.this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                finish("위치 권한이 해제되어 안내를 중지했습니다."); return;
            }
            if (freshFix()) {
                long now = SystemClock.elapsedRealtime();
                if (!fetching && (lastAttempt == 0 || now - lastAttempt >= 30000)) fetchPoints(new Location(fix));
                checkNearby();
            }
            notices.notify(ONGOING_ID, ongoing(message()));
            main.postDelayed(this, 5000);
        }
    };

    @Override public void onLocationChanged(Location location) {
        if (!running || !NearbyAlertPolicy.valid(location.getLatitude(), location.getLongitude()) || !location.hasAccuracy()) return;
        long age = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1000000;
        if (!NearbyAlertPolicy.usableFix(location.getAccuracy(), age, radius)) return;
        // Do not replace a recent precise GPS fix with a much less precise network fix.
        if (freshFix() && !LocationManager.GPS_PROVIDER.equals(location.getProvider())
                && (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) < TimeUnit.SECONDS.toNanos(10)
                && location.getAccuracy() > fix.getAccuracy() * 2) return;
        fix = new Location(location);
        if (!fetching && (lastAttempt == 0 || SystemClock.elapsedRealtime() - lastAttempt >= 30000)) fetchPoints(new Location(fix));
        checkNearby();
    }

    @Override public void onProviderDisabled(String provider) { if (LocationManager.GPS_PROVIDER.equals(provider)) fix = null; }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }

    private boolean freshFix() {
        return fix != null && NearbyAlertPolicy.usableFix(fix.getAccuracy(),
                (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1000000, radius);
    }

    private String message() {
        if (!freshFix()) return "정확한 GPS 위치를 기다리고 있습니다. 위치 기능을 켜 주세요.";
        return "반경 " + radius + "m 안내 중 · " + dataStatus + (upload && !uploadStatus.isEmpty() ? " · " + uploadStatus : "");
    }

    private void fetchPoints(Location center) {
        fetching = true;
        lastAttempt = SystemClock.elapsedRealtime();
        double range = Math.max(2000, radius * 3);
        io.execute(() -> {
            List<Point> received = new ArrayList<>();
            String errorMessage = null;
            boolean truncated = false;
            try {
                double dLat = range / 111000;
                double dLon = range / (111000 * Math.max(.01, Math.cos(Math.toRadians(center.getLatitude()))));
                String filter = String.format(Locale.US,
                        "&latitude=gte.%.7f&latitude=lte.%.7f&longitude=gte.%.7f&longitude=lte.%.7f",
                        Math.max(-90, center.getLatitude() - dLat), Math.min(90, center.getLatitude() + dLat),
                        Math.max(-180, center.getLongitude() - dLon), Math.min(180, center.getLongitude() + dLon));
                // Stable pagination avoids silently dropping records at the server's default page limit.
                for (int page = 0; page < 4; page++) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("요청 중지");
                    HttpURLConnection connection = (HttpURLConnection) new URL(endpoint
                            + "/rest/v1/potholes?select=id,latitude,longitude,status&order=id.asc&limit=500&offset=" + (page * 500) + filter).openConnection();
                    activeRequest = connection;
                    JSONArray rows;
                    try {
                        connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
                        connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
                        connection.setRequestProperty("apikey", publicKey);
                        connection.setRequestProperty("Accept", "application/json");
                        int status = connection.getResponseCode();
                        if (status != 200) throw new IOException("서버 조회 실패 (HTTP " + status + "). 테이블·접근 권한을 확인하세요.");
                        try (InputStream input = connection.getInputStream()) {
                            rows = new JSONArray(new String(BlackboxHttpPolicy.read(input, 2 * 1024 * 1024,
                                    System.nanoTime() + TimeUnit.SECONDS.toNanos(10)), StandardCharsets.UTF_8));
                        }
                    } finally { connection.disconnect(); activeRequest = null; }
                    for (int i = 0; i < rows.length(); i++) {
                        JSONObject row = rows.getJSONObject(i);
                        String state = row.optString("status");
                        if ("수리완료".equals(state) || "완료".equals(state) || "repaired".equalsIgnoreCase(state)) continue;
                        double lat = row.optDouble("latitude", Double.NaN), lon = row.optDouble("longitude", Double.NaN);
                        if (!NearbyAlertPolicy.valid(lat, lon)) continue;
                        String id = row.isNull("id") ? lat + ":" + lon : row.optString("id");
                        received.add(new Point(id, lat, lon));
                    }
                    if (rows.length() < 500) break;
                    if (page == 3) truncated = true;
                }
            } catch (Exception error) { errorMessage = error.getMessage(); }
            final String failure = errorMessage;
            final boolean partial = truncated;
            main.post(() -> {
                fetching = false;
                if (!running) return;
                if (failure == null) {
                    points = received; queryCenter = center; queryRange = range; lastSuccess = SystemClock.elapsedRealtime();
                    dataStatus = partial ? "조회 한도 도달 · 일부 포트홀만 안내" : points.size() + "개 확인";
                    checkNearby();
                } else {
                    dataStatus = "정보 갱신 실패 · 인터넷/서버 확인";
                    android.util.Log.w("NearbyAlerts", failure == null ? "Fetch failed" : failure);
                }
            });
        });
    }

    private void checkNearby() {
        if (!running || !freshFix() || queryCenter == null || SystemClock.elapsedRealtime() - lastSuccess > 5 * 60000) return;
        if (NearbyAlertPolicy.distance(fix.getLatitude(), fix.getLongitude(), queryCenter.getLatitude(), queryCenter.getLongitude()) + radius > queryRange) return;
        Point nearest = null;
        double distance = Double.MAX_VALUE;
        long now = SystemClock.elapsedRealtime();
        for (Point point : points) {
            double meters = NearbyAlertPolicy.distance(fix.getLatitude(), fix.getLongitude(), point.latitude, point.longitude);
            if (meters < distance && policy.eligible(point.id, meters, radius, now)) { nearest = point; distance = meters; }
        }
        if (nearest == null) return;
        if (!androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 26 && notices.getNotificationChannel(WARNINGS).getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        String message = "주변 약 " + Math.max(10, Math.round(distance / 10) * 10) + "미터에 포트홀이 있습니다. 주의하세요.";
        notices.notify(WARNING_ID, new NotificationCompat.Builder(this, WARNINGS)
                .setSmallIcon(R.drawable.ic_nearby_warning).setContentTitle("주변 포트홀 주의")
                .setContentText(message).setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setContentIntent(openApp()).setAutoCancel(true).setTimeoutAfter(60000)
                .setPriority(NotificationCompat.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
        policy.mark(nearest.id, now);
        if (voice) speak(message);
    }

    private PendingIntent openApp() {
        return PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification ongoing(String message) {
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, NearbyAlertService.class).setAction(STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, TRACKING).setSmallIcon(R.drawable.ic_nearby_warning)
                .setContentTitle("주변 포트홀 안내 실행 중").setContentText(message).setContentIntent(openApp())
                .setOngoing(true).setOnlyAlertOnce(true).setPriority(NotificationCompat.PRIORITY_LOW)
                .addAction(0, "안내 중지", stop).setCategory(NotificationCompat.CATEGORY_SERVICE).build();
    }

    private void initializeSpeech() {
        tts = new TextToSpeech(this, status -> main.post(() -> {
            if (!running || tts == null) return;
            if (status != TextToSpeech.SUCCESS) { voiceStatus = "음성 엔진을 사용할 수 없어 알림음만 사용합니다."; return; }
            int language = tts.setLanguage(Locale.KOREAN);
            ttsReady = language != TextToSpeech.LANG_MISSING_DATA && language != TextToSpeech.LANG_NOT_SUPPORTED;
            voiceStatus = ttsReady ? "한국어 음성 준비됨" : "한국어 음성 데이터가 없어 알림음만 사용합니다.";
            tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { main.post(() -> abandonFocus()); }
                @Override public void onError(String id) { main.post(() -> abandonFocus()); }
            });
        }));
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        if (change < 0) { if (tts != null) tts.stop(); abandonFocus(); }
    };

    @SuppressWarnings("deprecation") private void speak(String message) {
        if (!ttsReady || tts == null || audio == null) return;
        // Respect silent/vibrate modes and Do Not Disturb rather than using speech to bypass them.
        if (audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return;
        if (Build.VERSION.SDK_INT >= 23 && notices.getCurrentInterruptionFilter() != NotificationManager.INTERRUPTION_FILTER_ALL) return;
        int granted;
        if (Build.VERSION.SDK_INT >= 26) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(focusListener, main).build();
            granted = audio.requestAudioFocus(focus);
        } else granted = audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return;
        if (tts.speak(message, TextToSpeech.QUEUE_FLUSH, null, "nearby-" + SystemClock.elapsedRealtime()) == TextToSpeech.ERROR) abandonFocus();
    }

    @SuppressWarnings("deprecation") private void abandonFocus() {
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= 26 && focus != null) { audio.abandonAudioFocusRequest(focus); focus = null; }
        else if (Build.VERSION.SDK_INT < 26) audio.abandonAudioFocus(focusListener);
    }

    private void finish(String message) {
        running = false; lastMessage = message;
        cleanup(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }

    private void cleanup() {
        main.removeCallbacks(tick);
        main.removeCallbacks(uploader);
        uploadIo.shutdownNow();
        if (locations != null) {
            try { locations.removeUpdates(this); } catch (SecurityException ignored) { }
        }
        HttpURLConnection request = activeRequest;
        if (request != null) request.disconnect();
        io.shutdownNow();
        if (tts != null) { tts.stop(); tts.shutdown(); tts = null; }
        abandonFocus();
        if (notices != null) notices.cancel(WARNING_ID);
    }

    @Override public void onDestroy() {
        running = false;
        cleanup();
        if (instance == this) instance = null;
        super.onDestroy();
    }
}
