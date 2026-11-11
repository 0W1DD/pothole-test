package kr.ac.kongju.pothole;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.MacAddress;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * B형 블랙박스 와이파이 자동 연결 (Android 10+ Wi-Fi Network Request API).
 * - 처음 한 번: SSID/비밀번호로 요청 → 폰이 "연결할까요?" 창 → 허용
 * - 연결되면 BSSID(공유기 고유주소)를 저장 → 다음부터 SSID+BSSID로 정확히 요청 → 창 없이 자동 연결
 * - 이 연결은 인터넷 없는 앱 전용 통로. 파이 접속(get)만 이 통로로 보내고, 업로드는 평소대로 LTE.
 */
@CapacitorPlugin(name = "BlackboxWifi")
public class BlackboxWifiPlugin extends Plugin {
    private static final String PREF = "blackbox_wifi";
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback callback;
    private volatile Network network;
    private volatile String state = "idle";   // idle | connecting | connected | unavailable | lost
    private PluginCall pending;

    @Override
    public void load() {
        cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    private JSObject info() {
        SharedPreferences p = prefs();
        JSObject o = new JSObject();
        o.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        o.put("state", state);
        o.put("connected", network != null);
        o.put("ssid", p.getString("ssid", ""));
        o.put("bssid", p.getString("bssid", ""));
        o.put("registered", !p.getString("ssid", "").isEmpty());
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(info()); }

    /** 등록 정보 저장 (SSID나 비밀번호가 바뀌면 BSSID는 지움) */
    @PluginMethod
    public void register(PluginCall call) {
        String ssid = call.getString("ssid", "");
        String pw = call.getString("password", "");
        SharedPreferences p = prefs();
        SharedPreferences.Editor e = p.edit();
        if (!ssid.equals(p.getString("ssid", "")) || !pw.equals(p.getString("password", ""))) e.remove("bssid");
        e.putString("ssid", ssid).putString("password", pw).apply();
        call.resolve(info());
    }

    @PluginMethod
    public void forget(PluginCall call) {
        releaseNetwork();
        prefs().edit().clear().apply();
        call.resolve(info());
    }

    /** 저장된 블랙박스 와이파이에 연결 (이미 연결돼 있으면 바로 성공) */
    @PluginMethod
    public void connect(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { call.reject("안드로이드 10 이상 필요"); return; }
        if (network != null) { call.resolve(info()); return; }
        SharedPreferences p = prefs();
        String ssid = p.getString("ssid", "");
        if (ssid.isEmpty()) { call.reject("먼저 블랙박스 등록"); return; }
        if ("connecting".equals(state) && pending != null) { call.reject("연결 중"); return; }

        WifiNetworkSpecifier.Builder b = new WifiNetworkSpecifier.Builder().setSsid(ssid);
        String pw = p.getString("password", "");
        if (!pw.isEmpty()) b.setWpa2Passphrase(pw);
        String bssid = p.getString("bssid", "");
        if (!bssid.isEmpty()) {
            try { b.setBssid(MacAddress.fromString(bssid)); } catch (Exception ignored) {}
        }
        NetworkRequest req = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)   // 인터넷 없는 기기 연결
                .setNetworkSpecifier(b.build())
                .build();

        releaseNetwork();
        state = "connecting";
        pending = call;
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                network = n;
                state = "connected";
                saveBssid(n);
                finish(true, null);
                notifyListeners("change", info());
            }
            @Override public void onUnavailable() {
                network = null;
                state = "unavailable";
                finish(false, "블랙박스 와이파이를 못 찾았거나 거절됨");
                notifyListeners("change", info());
            }
            @Override public void onLost(Network n) {
                network = null;
                state = "lost";
                notifyListeners("change", info());
            }
        };
        try {
            cm.requestNetwork(req, callback, 20000);   // 20초 안에 못 붙으면 onUnavailable
        } catch (Exception ex) {
            state = "idle";
            finish(false, "요청 실패: " + ex.getMessage());
        }
    }

    private void saveBssid(Network n) {
        try {
            String bssid = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                if (nc != null && nc.getTransportInfo() instanceof WifiInfo) bssid = ((WifiInfo) nc.getTransportInfo()).getBSSID();
            }
            if (bssid == null) {
                WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null && wm.getConnectionInfo() != null) bssid = wm.getConnectionInfo().getBSSID();
            }
            if (bssid != null && !bssid.equals("02:00:00:00:00:00")) prefs().edit().putString("bssid", bssid).apply();
        } catch (Exception ignored) {}
    }

    private void finish(boolean ok, String err) {
        PluginCall c = pending;
        pending = null;
        if (c == null) return;
        if (ok) c.resolve(info()); else c.reject(err);
    }

    private void releaseNetwork() {
        if (callback != null) { try { cm.unregisterNetworkCallback(callback); } catch (Exception ignored) {} }
        callback = null;
        network = null;
        state = "idle";
    }

    @PluginMethod
    public void disconnect(PluginCall call) { releaseNetwork(); call.resolve(info()); }

    /** 블랙박스 통로로만 HTTP GET. asBlob=true면 base64로 돌려줌 */
    @PluginMethod
    public void get(PluginCall call) {
        final Network n = network;
        if (n == null) { call.reject("블랙박스 와이파이 연결 안 됨"); return; }
        final String url = call.getString("url");
        final boolean asBlob = Boolean.TRUE.equals(call.getBoolean("asBlob", false));
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                con = (HttpURLConnection) n.openConnection(new URL(url));
                con.setConnectTimeout(3000);
                con.setReadTimeout(5000);
                con.setUseCaches(false);
                int code = con.getResponseCode();
                InputStream in = code < 400 ? con.getInputStream() : con.getErrorStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (in != null) { byte[] buf = new byte[8192]; int r; while ((r = in.read(buf)) > 0) out.write(buf, 0, r); in.close(); }
                JSObject o = new JSObject();
                o.put("status", code);
                byte[] bytes = out.toByteArray();
                o.put("data", asBlob ? Base64.encodeToString(bytes, Base64.NO_WRAP) : new String(bytes, "UTF-8"));
                call.resolve(o);
            } catch (Exception ex) {
                call.reject("파이 접속 실패: " + ex.getMessage());
            } finally {
                if (con != null) con.disconnect();
            }
        }).start();
    }

    @Override
    protected void handleOnDestroy() { releaseNetwork(); }
}
