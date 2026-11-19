package com.gimmegimme.pothole;

/** Timing/quality rules for the opt-in live gps_logs stream. */
public final class GpsUploadPolicy {
    public static final long UPLOAD_EVERY_MS = 2000, GPS_FAST_MS = 1000;
    public static boolean usableFix(boolean gps, float accuracy, long ageMs, long fixNanos, long lastNanos) {
        return gps && Float.isFinite(accuracy) && accuracy > 0 && accuracy <= 30
                && ageMs >= 0 && ageMs <= 5000 && fixNanos > 0 && fixNanos != lastNanos;
    }
}
