package com.gimmegimme.pothole;

public class NearbyAlertPolicyTest {
    private static int count;
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        count++;
    }
    public static void main(String[] args) {
        check(NearbyAlertPolicy.distance(37, 127, 37, 127) == 0, "same point");
        double km = NearbyAlertPolicy.distance(0, 0, 0, .01);
        check(km > 1110 && km < 1113, "known equatorial distance");
        check(!NearbyAlertPolicy.valid(Double.NaN, 127), "NaN rejected");
        check(!NearbyAlertPolicy.valid(91, 127), "invalid latitude");
        check(!NearbyAlertPolicy.valid(37, 181), "invalid longitude");
        check(NearbyAlertPolicy.usableFix(10, 5000, 200), "fresh precise fix");
        check(!NearbyAlertPolicy.usableFix(10, 31000, 200), "stale fix");
        check(!NearbyAlertPolicy.usableFix(101, 5000, 200), "poor accuracy");
        check(!NearbyAlertPolicy.usableFix(80, 5000, 100), "accuracy relative to radius");
        check(!NearbyAlertPolicy.usableFix(10, -1, 200), "future fix");
        NearbyAlertPolicy policy = new NearbyAlertPolicy();
        check(!policy.eligible("a", 201, 200, 1000), "outside radius");
        check(policy.eligible("a", 200, 200, 1000), "radius boundary");
        policy.mark("a", 1000);
        check(!policy.eligible("a", 10, 200, 61000), "same point cooldown");
        check(!policy.eligible("b", 10, 200, 1100), "global anti-spam gap");
        check(policy.eligible("b", 10, 200, 31000), "other point after gap");
        check(policy.eligible("a", 10, 200, 601000), "cooldown elapsed");
        check(!policy.eligible("c", Double.NaN, 200, 601000), "invalid distance");
        check(NearbyAlertPolicy.ahead(350, 10), "wraparound ahead");
        check(NearbyAlertPolicy.ahead(10, 340), "negative 30 degree boundary");
        check(!NearbyAlertPolicy.ahead(0, 31), "outside cone");
        check(!NearbyAlertPolicy.ahead(0, 180), "behind");
        check(!NearbyAlertPolicy.ahead(Double.NaN, 0), "unknown course");
        check(Math.abs(NearbyAlertPolicy.bearing(0, 0, 0, 1) - 90) < .01, "east bearing");
        check(policy.eligibleAhead("front", 299, 300, 0, 0, 1000), "300m stage");
        policy.markAhead("front", 299, 1000);
        check(!policy.eligibleAhead("front", 150, 300, 0, 0, 6100), "same stage suppressed");
        check(policy.eligibleAhead("front", 100, 300, 0, 0, 6100), "100m stage");
        policy.markAhead("front", 100, 6100);
        check(!policy.eligibleAhead("front", 50, 300, 0, 0, 7000), "global speech gap");
        check(policy.eligibleAhead("front", 50, 300, 0, 0, 12000), "50m stage");
        policy.markAhead("front", 50, 12000);
        check(!policy.eligibleAhead("front", 290, 300, 0, 0, 999999), "no outward repeat");
        check(!policy.eligibleAhead("front", 10, 300, 0, 0, 999999), "no close repeat");
        check(!policy.eligibleAhead("behind", 50, 300, 0, 180, 999999), "rear point excluded");
        check(!policy.eligibleAhead("far", 301, 1000, 0, 0, 999999), "stage maximum");
        check(!policy.eligibleAhead("radius", 250, 200, 0, 0, 999999), "user radius respected");
        check(NearbyAlertPolicy.stage(50) == 50 && NearbyAlertPolicy.stage(100) == 100 && NearbyAlertPolicy.stage(300) == 300, "threshold boundaries");
        System.out.println("Nearby alert policy: " + count + " checks passed");
    }
}
