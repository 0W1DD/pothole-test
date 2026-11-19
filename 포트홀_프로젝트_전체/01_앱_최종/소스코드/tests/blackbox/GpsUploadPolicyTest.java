package com.gimmegimme.pothole;
public class GpsUploadPolicyTest {
    private static int count;
    private static void check(boolean value) { if (!value) throw new AssertionError("Check " + count); count++; }
    public static void main(String[] args) {
        check(GpsUploadPolicy.UPLOAD_EVERY_MS == 2000);
        check(GpsUploadPolicy.GPS_FAST_MS == 1000);
        check(GpsUploadPolicy.usableFix(true, 30, 5000, 20, 10));
        check(!GpsUploadPolicy.usableFix(false, 10, 100, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, 31, 100, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, Float.NaN, 100, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, 0, 100, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, 10, 5001, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, 10, -1, 20, 10));
        check(!GpsUploadPolicy.usableFix(true, 10, 100, 20, 20));
        check(!GpsUploadPolicy.usableFix(true, 10, 100, 0, 10));
        System.out.println("GPS upload policy: " + count + " checks passed");
    }
}
