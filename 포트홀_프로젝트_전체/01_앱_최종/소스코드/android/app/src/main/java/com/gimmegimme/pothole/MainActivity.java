package com.gimmegimme.pothole;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BlackboxWifiPlugin.class);
        registerPlugin(NearbyAlertsPlugin.class);
        registerPlugin(DetectionAlertsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
