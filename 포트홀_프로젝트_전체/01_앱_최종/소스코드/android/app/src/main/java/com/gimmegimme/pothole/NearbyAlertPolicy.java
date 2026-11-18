package com.gimmegimme.pothole;

import java.util.HashMap;
import java.util.Map;

/** Pure Java policy shared by the location service and deterministic tests. */
public final class NearbyAlertPolicy {
    public static final long COOLDOWN_MS = 10 * 60 * 1000L;
    public static final long GAP_MS = 30 * 1000L;
    private final Map<String, Long> notified = new HashMap<>();
    private long lastAlert = Long.MIN_VALUE;

    public static double distance(double lat1, double lon1, double lat2, double lon2) {
        double a = Math.pow(Math.sin(Math.toRadians(lat2 - lat1) / 2), 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
                * Math.pow(Math.sin(Math.toRadians(lon2 - lon1) / 2), 2);
        return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
    }

    public static boolean valid(double latitude, double longitude) {
        return Double.isFinite(latitude) && Double.isFinite(longitude)
                && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    }

    public static boolean usableFix(float accuracy, long ageMs, int radius) {
        return Float.isFinite(accuracy) && accuracy > 0 && accuracy <= Math.min(100, radius / 2f)
                && ageMs >= 0 && ageMs <= 30000;
    }

    public boolean eligible(String id, double meters, int radius, long now) {
        Long previous = notified.get(id);
        return Double.isFinite(meters) && meters >= 0 && meters <= radius
                && (lastAlert == Long.MIN_VALUE || now - lastAlert >= GAP_MS)
                && (previous == null || now - previous >= COOLDOWN_MS);
    }

    public void mark(String id, long now) {
        notified.entrySet().removeIf(entry -> now - entry.getValue() >= COOLDOWN_MS);
        notified.put(id, now);
        lastAlert = now;
    }
}
