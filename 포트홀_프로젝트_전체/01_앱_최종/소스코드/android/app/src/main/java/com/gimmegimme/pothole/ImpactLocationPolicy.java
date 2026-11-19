package com.gimmegimme.pothole;

final class ImpactLocationPolicy {
    static final long WINDOW_MS = 2000;
    static final long RETENTION_MS = 7L * 24 * 60 * 60 * 1000;
    static boolean usable(boolean gps, double lat, double lon, float accuracy,
                          long timestamp, long age, long now) {
        return gps && Double.isFinite(lat) && Math.abs(lat) <= 90
                && Double.isFinite(lon) && Math.abs(lon) <= 180
                && Float.isFinite(accuracy) && accuracy > 0 && accuracy <= 30
                && age >= 0 && age <= 5000 && timestamp > 0 && timestamp <= now
                && Math.abs((now - timestamp) - age) <= WINDOW_MS;
    }
    static boolean matches(long impact, long sample, long now) {
        return impact > 0 && impact <= now && impact >= now - RETENTION_MS
                && sample > 0 && sample <= now && sample >= now - RETENTION_MS
                && Math.abs(sample - impact) <= WINDOW_MS;
    }
}
