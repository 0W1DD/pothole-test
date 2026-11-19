package com.gimmegimme.pothole;

import java.util.HashMap;
import java.util.Map;

/** Pure Java policy shared by the location service and deterministic tests. */
public final class NearbyAlertPolicy {
    public static final long COOLDOWN_MS = 10 * 60 * 1000L;
    public static final long GAP_MS = 30 * 1000L;
    private final Map<String, Long> notified = new HashMap<>();
    private long lastAlert = Long.MIN_VALUE;
    private final Map<String, Integer> stages = new HashMap<>();
    private long lastStageAlert = Long.MIN_VALUE;

    public static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double d = Math.toRadians(lon2 - lon1), a = Math.toRadians(lat1), b = Math.toRadians(lat2);
        return (Math.toDegrees(Math.atan2(Math.sin(d) * Math.cos(b),
                Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d))) + 360) % 360;
    }

    public static boolean ahead(double heading, double targetBearing) {
        if (!Double.isFinite(heading) || !Double.isFinite(targetBearing)) return false;
        double delta = ((targetBearing - heading) % 360 + 540) % 360 - 180;
        return Math.abs(delta) <= 30;
    }

    public static int stage(double meters) {
        if (!Double.isFinite(meters) || meters < 0 || meters > 300) return 0;
        return meters <= 50 ? 50 : meters <= 100 ? 100 : 300;
    }

    public boolean eligibleAhead(String id, double meters, int radius, double heading, double bearing, long now) {
        int next = stage(meters);
        Integer previous = stages.get(id);
        return next > 0 && meters <= radius && ahead(heading, bearing)
                && (previous == null || next < previous)
                && (lastStageAlert == Long.MIN_VALUE || now - lastStageAlert >= 5000);
    }

    public void markAhead(String id, double meters, long now) {
        stages.put(id, stage(meters)); lastStageAlert = now;
    }

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
