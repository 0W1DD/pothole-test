package com.gimmegimme.pothole;

import android.Manifest;
import android.app.*;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;

@CapacitorPlugin(name = "DetectionAlerts", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class DetectionAlertsPlugin extends Plugin {
    private static final String CHANNEL = "pothole_detection_v1";
    private boolean requesting;
    private void channel() {
        if (Build.VERSION.SDK_INT >= 26) getContext().getSystemService(NotificationManager.class)
            .createNotificationChannel(new NotificationChannel(CHANNEL, "새 포트홀 감지", NotificationManager.IMPORTANCE_DEFAULT));
    }
    @PluginMethod public void enable(PluginCall call) {
        if (requesting) { call.reject("알림 권한 요청을 완료해 주세요."); return; }
        channel();
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requesting = true;
            requestPermissionForAlias("notifications", call, "permissionsResult");
        } else permissionsResult(call);
    }
    @PermissionCallback private void permissionsResult(PluginCall call) {
        requesting = false;
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            call.reject("휴대폰 설정에서 앱 알림을 허용하세요."); return;
        }
        if (Build.VERSION.SDK_INT >= 26 && getContext().getSystemService(NotificationManager.class)
                .getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) {
            call.reject("새 포트홀 감지 알림 채널을 허용하세요."); return;
        }
        call.resolve();
    }
    @PluginMethod public void notifyDetection(PluginCall call) {
        String id = call.getString("id");
        Double lat = call.getDouble("lat"), lon = call.getDouble("lon");
        if (id == null || id.length() > 120 || lat == null || lon == null || !NearbyAlertPolicy.valid(lat, lon)) {
            call.reject("포트홀 위치가 올바르지 않습니다."); return;
        }
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) { call.reject("알림 권한이 없습니다."); return; }
        channel();
        Intent intent = new Intent(getContext(), MainActivity.class)
            .setData(Uri.parse("pothole-detection://open/" + Uri.encode(id)))
            .putExtra("detection_id", id).putExtra("detection_lat", lat.doubleValue()).putExtra("detection_lon", lon.doubleValue())
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open = PendingIntent.getActivity(getContext(), 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(getContext(), CHANNEL)
            .setSmallIcon(R.drawable.ic_nearby_warning).setContentTitle("근처에 새 포트홀이 감지됐습니다")
            .setContentText("눌러서 지도에서 위치를 확인하세요.").setContentIntent(open).setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
        try { NotificationManagerCompat.from(getContext()).notify("detection:" + id, 7200, notification); call.resolve(); }
        catch (SecurityException error) { call.reject("알림 권한을 확인하세요."); }
    }
    @PluginMethod public void consumeTap(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent intent = getActivity().getIntent();
            JSObject result = new JSObject();
            if (intent.hasExtra("detection_id")) {
                result.put("id", intent.getStringExtra("detection_id"));
                result.put("lat", intent.getDoubleExtra("detection_lat", 0));
                result.put("lon", intent.getDoubleExtra("detection_lon", 0));
                intent.removeExtra("detection_id"); intent.removeExtra("detection_lat"); intent.removeExtra("detection_lon");
            }
            call.resolve(result);
        });
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        getActivity().setIntent(intent);
        if (intent.hasExtra("detection_id")) notifyListeners("tap", new JSObject(), true);
    }
}
