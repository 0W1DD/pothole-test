package com.gimmegimme.pothole;
public class ImpactLocationPolicyTest {
    private static int count;
    private static void check(boolean value) { if (!value) throw new AssertionError("Check " + count); count++; }
    public static void main(String[] args) {
        long now = 1795040000000L;
        check(ImpactLocationPolicy.usable(true, 37, 127, 30, now - 5000, 5000, now));
        check(!ImpactLocationPolicy.usable(false, 37, 127, 5, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 91, 127, 5, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, Double.NaN, 5, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 31, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, Float.NaN, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 0, now, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 5, now - 5001, 5001, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 5, now, -1, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 5, now + 1, 0, now));
        check(!ImpactLocationPolicy.usable(true, 37, 127, 5, now - 2001, 0, now));
        long impact = now - 60000;
        check(ImpactLocationPolicy.matches(impact, impact, now));
        check(ImpactLocationPolicy.matches(impact, impact - 2000, now));
        check(ImpactLocationPolicy.matches(impact, impact + 2000, now));
        check(!ImpactLocationPolicy.matches(impact, impact - 2001, now));
        check(!ImpactLocationPolicy.matches(impact, impact + 2001, now));
        check(!ImpactLocationPolicy.matches(impact, now, now));
        check(!ImpactLocationPolicy.matches(now + 1, now, now));
        check(!ImpactLocationPolicy.matches(0, 0, now));
        check(!ImpactLocationPolicy.matches(Long.MIN_VALUE, impact, now));
        check(!ImpactLocationPolicy.matches(now - ImpactLocationPolicy.RETENTION_MS - 1, now - ImpactLocationPolicy.RETENTION_MS, now));
        check(ImpactLocationPolicy.matches(now - ImpactLocationPolicy.RETENTION_MS, now - ImpactLocationPolicy.RETENTION_MS, now));
        System.out.println("Impact location policy: " + count + " checks passed");
    }
}
