package kr.ac.kongju.pothole;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BlackboxWifiPlugin.class);   // B형 블랙박스 와이파이 자동 연결
        super.onCreate(savedInstanceState);
        // 측정하는 동안 화면 안꺼지게 (꺼지면 웹뷰 센서 멈춤)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // 블랙박스 와이파이 찾기에 필요한 권한 (안드로이드 13+: 주변 기기, 그 아래: 위치)
        if (Build.VERSION.SDK_INT >= 33) {
            ActivityCompat.requestPermissions(this, new String[]{
                "android.permission.NEARBY_WIFI_DEVICES",
                "android.permission.ACCESS_FINE_LOCATION"}, 7);
        } else {
            ActivityCompat.requestPermissions(this, new String[]{
                "android.permission.ACCESS_FINE_LOCATION"}, 7);
        }
    }
}
