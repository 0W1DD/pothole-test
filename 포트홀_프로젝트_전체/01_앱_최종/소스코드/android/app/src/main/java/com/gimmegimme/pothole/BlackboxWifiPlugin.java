package com.gimmegimme.pothole;

import android.Manifest;
import android.content.Context;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.MacAddress;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Adapted from 0W1DD/pothole-test BlackboxWifiPlugin (register/connect/status/get contract).
 * Only camera GETs use the requested Network. All other app traffic uses Android's default route.
 * Connection lifetime is this foreground app session; there is no background service.
 */
@CapacitorPlugin(name = "BlackboxWifi", permissions = {
    @Permission(alias = "location", strings = {
        Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION
    }),
    @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES })
})
public class BlackboxWifiPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor io = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(4));
    private final Set<HttpURLConnection> connections = ConcurrentHashMap.newKeySet();
    private ConnectivityManager cm;
    private BlackboxCredentials credentials;
    private JSONObject settings = new JSONObject();
    private ConnectivityManager.NetworkCallback callback;
    private volatile Network network;
    private volatile boolean destroyed;
    // Settings, callback, state, and pending are confined to the main thread.
    private String state = "idle";
    private String storageError = "";
    private PluginCall pending;
    private boolean permissionRequestActive;

    @Override public void load() {
        cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        credentials = new BlackboxCredentials(getContext());
        try { settings = credentials.load(); }
        catch (Exception error) { storageError = "저장 정보를 읽지 못했습니다. 블랙박스를 다시 등록하세요."; }
    }

    private boolean locationEnabled() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        return Build.VERSION.SDK_INT >= 28 && lm != null && lm.isLocationEnabled();
    }

    private boolean permissionsGranted() {
        return getPermissionState("location") == PermissionState.GRANTED
                && (Build.VERSION.SDK_INT < 33 || getPermissionState("nearbyWifi") == PermissionState.GRANTED);
    }

    private JSObject info() {
        JSObject result = new JSObject();
        result.put("supported", Build.VERSION.SDK_INT >= 29);
        result.put("state", state);
        result.put("connected", network != null);
        result.put("registered", !settings.optString("ssid").isEmpty());
        result.put("ssid", settings.optString("ssid"));
        result.put("bssid", settings.optString("bssid"));
        result.put("locationEnabled", locationEnabled());
        result.put("locationPermission", getPermissionState("location").toString());
        result.put("nearbyWifiPermission", Build.VERSION.SDK_INT >= 33
                ? getPermissionState("nearbyWifi").toString() : "not-required");
        result.put("storageError", storageError);
        Network active = cm == null ? null : cm.getActiveNetwork();
        NetworkCapabilities caps = active == null ? null : cm.getNetworkCapabilities(active);
        result.put("internetValidated", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        result.put("internetTransport", caps == null ? "none"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ? "vpn"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : "other");
        return result;
    }

    private void changed() { if (!destroyed) notifyListeners("change", info()); }

    @PluginMethod public void status(PluginCall call) { main.post(() -> call.resolve(info())); }

    @PluginMethod public void register(PluginCall call) {
        main.post(() -> {
            String ssid = call.getString("ssid", "");
            String password = call.getString("password", "");
            int length = ssid.getBytes(StandardCharsets.UTF_8).length;
            if (length < 1 || length > 32 || ssid.indexOf('\0') >= 0) {
                call.reject("Wi-Fi 이름은 UTF-8 기준 1~32바이트여야 합니다.", "INVALID_SSID"); return;
            }
            if (!password.isEmpty() && (password.length() < 8 || password.length() > 63
                    || !password.matches("[\\x20-\\x7E]+"))) {
                call.reject("WPA2 비밀번호는 영문·숫자·기호 8~63자여야 합니다. 개방형 Wi-Fi는 빈 문자열을 쓰세요.", "INVALID_PASSWORD"); return;
            }
            try {
                boolean same = ssid.equals(settings.optString("ssid")) && password.equals(settings.optString("password"));
                JSONObject next = new JSONObject();
                next.put("ssid", ssid).put("password", password);
                if (same) next.put("bssid", settings.optString("bssid"));
                credentials.save(next);
                if (!same) release("idle", "등록 정보가 변경되어 연결을 취소했습니다.");
                settings = next;
                storageError = "";
                call.resolve(info()); changed();
            } catch (Exception error) { call.reject("Wi-Fi 등록 정보를 저장하지 못했습니다.", "STORAGE_ERROR"); }
        });
    }

    @PluginMethod public void connect(PluginCall call) {
        main.post(() -> {
            if (Build.VERSION.SDK_INT < 29) { call.reject("Android 10 이상이 필요합니다.", "UNSUPPORTED"); return; }
            if (destroyed) { call.reject("앱 화면이 종료되었습니다.", "DESTROYED"); return; }
            if (pending != null || permissionRequestActive) { call.reject("이미 연결을 요청하고 있습니다.", "BUSY"); return; }
            if (settings.optString("ssid").isEmpty()) { call.reject("먼저 블랙박스를 등록하세요.", "NOT_REGISTERED"); return; }
            if (network != null && permissionsGranted() && locationEnabled()) { call.resolve(info()); return; }
            release("idle", "새 연결을 요청했습니다.");
            pending = call;
            state = "requesting_permissions"; changed();
            if (permissionsGranted()) beginConnect(call);
            else {
                try {
                    permissionRequestActive = true;
                    requestPermissionForAliases(Build.VERSION.SDK_INT >= 33
                            ? new String[] { "location", "nearbyWifi" } : new String[] { "location" },
                            call, "wifiPermissionsResult");
                } catch (Exception error) {
                    permissionRequestActive = false;
                    fail("권한 요청을 시작하지 못했습니다.", "PERMISSION_ERROR");
                }
            }
        });
    }

    @PermissionCallback private void wifiPermissionsResult(PluginCall call) {
        main.post(() -> {
            permissionRequestActive = false;
            if (call == null || pending != call || destroyed) return;
            if (!permissionsGranted()) {
                fail("앱 설정에서 정확한 위치와 주변 Wi-Fi 기기 권한을 허용하세요.", "PERMISSION_DENIED"); return;
            }
            beginConnect(call);
        });
    }

    private void beginConnect(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29) { fail("Android 10 이상이 필요합니다.", "UNSUPPORTED"); return; }
        if (pending != call || destroyed) return;
        if (!locationEnabled()) { fail("휴대폰의 위치 기능을 켜 주세요.", "LOCATION_DISABLED"); return; }
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null || !wm.isWifiEnabled()) { fail("휴대폰의 Wi-Fi를 켜 주세요.", "WIFI_DISABLED"); return; }
        try {
            WifiNetworkSpecifier.Builder spec = new WifiNetworkSpecifier.Builder().setSsid(settings.optString("ssid"));
            String password = settings.optString("password");
            if (!password.isEmpty()) spec.setWpa2Passphrase(password);
            String bssid = settings.optString("bssid");
            if (!bssid.isEmpty()) spec.setBssid(MacAddress.fromString(bssid));
            NetworkRequest request = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .setNetworkSpecifier(spec.build()).build();
            // API 31+ needs this flag plus precise-location permission to expose the requested AP's BSSID.
            callback = Build.VERSION.SDK_INT >= 31
                    ? new CameraCallback(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO)
                    : new CameraCallback();
            state = "connecting"; changed();
            cm.requestNetwork(request, callback, main, 30000);
        } catch (SecurityException error) {
            fail("Wi-Fi 연결 권한이 없습니다. 앱 권한을 확인하세요.", "PERMISSION_DENIED");
        } catch (Exception error) { fail("블랙박스 연결 요청을 시작하지 못했습니다.", "CONNECT_FAILED"); }
    }

    private final class CameraCallback extends ConnectivityManager.NetworkCallback {
        CameraCallback() { super(); }
        @androidx.annotation.RequiresApi(31) CameraCallback(int flags) { super(flags); }
        private boolean current() { return callback == this && !destroyed; }

        @Override public void onAvailable(Network available) {
            if (!current()) return;
            network = available;
            state = "connected";
            // Android 10/11 have no concurrent local-only secondary STA. Verify SSID before saving the legacy WifiInfo.
            if (Build.VERSION.SDK_INT < 31) saveLegacyBssid();
            PluginCall waiting = pending; pending = null;
            if (waiting != null) waiting.resolve(info());
            changed();
        }

        @Override public void onCapabilitiesChanged(Network available, NetworkCapabilities caps) {
            if (!current() || !available.equals(network)) return;
            if (Build.VERSION.SDK_INT >= 29 && caps.getTransportInfo() instanceof WifiInfo) {
                saveBssid((WifiInfo) caps.getTransportInfo());
            }
        }

        @Override public void onUnavailable() {
            if (current()) fail("블랙박스를 찾지 못했거나 연결이 거절되었습니다. 전원·비밀번호를 확인하세요.", "UNAVAILABLE");
        }

        @Override public void onLost(Network lost) {
            if (current() && lost.equals(network)) {
                release("lost", "블랙박스 연결이 끊어졌습니다."); changed();
            }
        }
    }

    @SuppressWarnings("deprecation") private void saveLegacyBssid() {
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo wifi = wm == null ? null : wm.getConnectionInfo();
            if (wifi == null) return;
            String ssid = wifi.getSSID();
            String expected = settings.optString("ssid");
            if (expected.equals(ssid) || ("\"" + expected + "\"").equals(ssid)) saveBssid(wifi);
        } catch (SecurityException ignored) { /* Connection remains usable without a remembered BSSID. */ }
    }

    private void saveBssid(WifiInfo wifi) {
        String value = wifi.getBSSID();
        if (value == null || "02:00:00:00:00:00".equals(value) || "00:00:00:00:00:00".equals(value)
                || !value.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}") || value.equals(settings.optString("bssid"))) return;
        try {
            if ((Integer.parseInt(value.substring(0, 2), 16) & 1) != 0) return;
            JSONObject next = new JSONObject(settings.toString());
            next.put("bssid", value); credentials.save(next); settings = next; storageError = "";
        } catch (Exception error) { storageError = "BSSID를 저장하지 못했습니다. 다음 연결에서 승인이 필요할 수 있습니다."; }
        changed();
    }

    private void fail(String message, String code) {
        PluginCall waiting = pending; pending = null;
        release("unavailable", message);
        if (waiting != null) waiting.reject(message, code);
        changed();
    }

    private void release(String nextState, String reason) {
        ConnectivityManager.NetworkCallback old = callback;
        callback = null; network = null; state = nextState;
        if (old != null && cm != null) {
            try { cm.unregisterNetworkCallback(old); } catch (IllegalArgumentException ignored) { }
        }
        for (HttpURLConnection connection : connections) connection.disconnect();
        PluginCall waiting = pending; pending = null;
        if (waiting != null) waiting.reject(reason, "CANCELLED");
    }

    @PluginMethod public void disconnect(PluginCall call) {
        main.post(() -> { release("idle", "연결 요청을 취소했습니다."); call.resolve(info()); changed(); });
    }

    @PluginMethod public void forget(PluginCall call) {
        main.post(() -> {
            release("idle", "블랙박스 등록을 삭제했습니다.");
            credentials.clear(); settings = new JSONObject(); storageError = "";
            call.resolve(info()); changed();
        });
    }

    /** Only this method uses the camera Network; it never changes the process-wide default route. */
    @PluginMethod public void get(PluginCall call) {
        final URL target;
        try { target = BlackboxHttpPolicy.target(call.getString("url")); }
        catch (Exception error) { call.reject("http://10.42.0.1:8080 주소만 사용할 수 있습니다.", "INVALID_URL"); return; }
        final Network selected = network;
        if (selected == null || destroyed) { call.reject("블랙박스 Wi-Fi에 연결하세요.", "NOT_CONNECTED"); return; }
        final boolean asBlob = Boolean.TRUE.equals(call.getBoolean("asBlob", false));
        try {
            io.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    if (!selected.equals(network) || destroyed) throw new IllegalStateException("연결이 변경되었습니다.");
                    // NO_PROXY prevents a device/global proxy from redirecting camera requests off the local endpoint.
                    connection = (HttpURLConnection) selected.openConnection(target, Proxy.NO_PROXY);
                    connections.add(connection);
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
                    connection.setUseCaches(false); connection.setRequestMethod("GET");
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                    int code = connection.getResponseCode();
                    if (code >= 300 && code < 400) throw new IllegalStateException("블랙박스 리디렉션은 허용하지 않습니다.");
                    if (connection.getContentLengthLong() > BlackboxHttpPolicy.MAX_BYTES)
                        throw new IllegalStateException("응답 크기 제한 초과 (최대 8 MiB)");
                    byte[] bytes;
                    try (InputStream input = code >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                        bytes = BlackboxHttpPolicy.read(input, BlackboxHttpPolicy.MAX_BYTES, deadline);
                    }
                    if (!selected.equals(network) || destroyed) throw new IllegalStateException("연결이 변경되었습니다.");
                    JSObject result = new JSObject();
                    result.put("status", code); result.put("size", bytes.length);
                    result.put("contentType", connection.getContentType() == null ? "application/octet-stream" : connection.getContentType());
                    result.put("encoding", asBlob ? "base64" : "utf8");
                    result.put("data", asBlob ? Base64.encodeToString(bytes, Base64.NO_WRAP)
                            : new String(bytes, StandardCharsets.UTF_8));
                    call.resolve(result);
                } catch (Exception error) { call.reject("블랙박스 GET 실패: " + error.getMessage(), "GET_FAILED"); }
                finally {
                    if (connection != null) { connections.remove(connection); connection.disconnect(); }
                }
            });
        } catch (RejectedExecutionException error) { call.reject("사진 요청이 많습니다. 잠시 후 다시 시도하세요.", "BUSY"); }
    }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        main.post(() -> { release("idle", "앱 화면이 종료되었습니다."); io.shutdown(); });
    }
}
