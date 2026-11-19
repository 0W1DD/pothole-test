package com.gimmegimme.pothole;

import android.Manifest;
import android.content.Intent;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "NearbyAlerts", permissions = {
    @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class NearbyAlertsPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending;
    private boolean permissionsInFlight;

    private boolean allowed() {
        return getPermissionState("location") == PermissionState.GRANTED
                && (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
    }

    @PluginMethod public void start(PluginCall call) {
        main.post(() -> {
            if (pending != null || permissionsInFlight) { call.reject("이전 권한 요청을 완료해 주세요."); return; }
            int radius = call.getInt("radius", 300);
            if (radius < 50 || radius > 1000) { call.reject("안내 거리는 50~1000m로 설정해 주세요."); return; }
            pending = call;
            if (allowed()) launch(call);
            else {
                permissionsInFlight = true;
                try {
                    requestPermissionForAliases(Build.VERSION.SDK_INT >= 33
                            ? new String[] { "location", "notifications" } : new String[] { "location" }, call, "permissionsResult");
                } catch (Exception error) { permissionsInFlight = false; reject("권한 요청에 실패했습니다."); }
            }
        });
    }

    @PermissionCallback private void permissionsResult(PluginCall call) {
        main.post(() -> {
            permissionsInFlight = false;
            if (call == null || pending != call) return;
            if (!allowed()) { reject("정확한 위치와 알림 권한을 허용해야 안내를 시작할 수 있습니다."); return; }
            launch(call);
        });
    }

    private void reject(String message) {
        PluginCall call = pending; pending = null;
        if (call != null) call.reject(message);
    }

    private void launch(PluginCall call) {
        if (getActivity() == null || !getActivity().getLifecycle().getCurrentState()
                .isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) {
            reject("앱 화면으로 돌아온 뒤 안내 시작을 눌러 주세요."); return;
        }
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            reject("휴대폰 앱 설정에서 알림을 허용해 주세요."); return;
        }
        LocationManager manager = (LocationManager) getContext().getSystemService(android.content.Context.LOCATION_SERVICE);
        if (manager == null || !manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            reject("휴대폰의 위치 기능을 켜 주세요."); return;
        }
        Intent intent = new Intent(getContext(), NearbyAlertService.class);
        intent.putExtra("radius", call.getInt("radius", 300));
        intent.putExtra("voice", Boolean.TRUE.equals(call.getBoolean("voice", true)));
        intent.putExtra("upload", Boolean.TRUE.equals(call.getBoolean("upload", false)));
        intent.putExtra("result", new ResultReceiver(main) {
            @Override protected void onReceiveResult(int code, Bundle data) {
                if (pending != call) return;
                pending = null;
                if (code == 0) call.resolve(NearbyAlertService.snapshot(getContext()));
                else call.reject(data == null ? "안내를 시작하지 못했습니다." : data.getString("error"));
            }
        });
        try { ContextCompat.startForegroundService(getContext(), intent); }
        catch (Exception error) { reject("안내를 시작하지 못했습니다. 앱을 화면에 연 상태에서 다시 시도하세요."); }
    }

    @PluginMethod public void locationAt(PluginCall call) {
        Double timestamp = call.getDouble("timestamp");
        if (timestamp == null || !Double.isFinite(timestamp) || timestamp != Math.floor(timestamp)
                || timestamp <= 0 || timestamp > System.currentTimeMillis()) {
            call.reject("충격 시각이 올바르지 않습니다. 파이 시각을 확인하세요."); return;
        }
        ImpactLocationStore.get(getContext()).lookup(timestamp.longValue(), call);
    }

    @PluginMethod public void status(PluginCall call) {
        main.post(() -> call.resolve(NearbyAlertService.snapshot(getContext())));
    }

    @PluginMethod public void stop(PluginCall call) {
        main.post(() -> {
            reject("안내 시작 요청을 취소했습니다.");
            NearbyAlertService.stopRunning(getContext());
            call.resolve(NearbyAlertService.snapshot(getContext()));
        });
    }

    @Override protected void handleOnDestroy() {
        // The service owns GPS and speech; closing the WebView must not stop it.
        main.post(() -> reject("앱 화면이 닫혔습니다. 안내 상태는 앱을 다시 열어 확인하세요."));
    }
}
