package com.gimmegimme.pothole;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import android.location.LocationManager;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Measurement-time history survives process death, stays local, and is excluded from backups. */
final class ImpactLocationStore extends SQLiteOpenHelper {
    private static ImpactLocationStore instance;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private long lastPruned;
    static synchronized ImpactLocationStore get(Context context) {
        if (instance == null) instance = new ImpactLocationStore(context.getApplicationContext());
        return instance;
    }
    private ImpactLocationStore(Context context) {
        super(context, new File(context.getNoBackupFilesDir(), "impact-locations.db").getAbsolutePath(), null, 1);
    }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE fixes (timestamp INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, accuracy REAL NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }
    private void prune(SQLiteDatabase db, long now) {
        if (lastPruned == 0 || now < lastPruned || now - lastPruned >= 60000) {
            db.delete("fixes", "timestamp < ? OR timestamp > ?", new String[] {
                    Long.toString(now - ImpactLocationPolicy.RETENTION_MS), Long.toString(now) });
            lastPruned = now;
        }
    }
    void record(Location source) {
        final Location fix = new Location(source);
        long age = (SystemClock.elapsedRealtimeNanos() - fix.getElapsedRealtimeNanos()) / 1000000;
        if (!fix.hasAccuracy() || !ImpactLocationPolicy.usable(LocationManager.GPS_PROVIDER.equals(fix.getProvider()),
                fix.getLatitude(), fix.getLongitude(), fix.getAccuracy(), fix.getTime(), age, System.currentTimeMillis())) return;
        worker.execute(() -> {
            try {
                SQLiteDatabase db = getWritableDatabase();
                prune(db, System.currentTimeMillis());
                ContentValues row = new ContentValues();
                row.put("timestamp", fix.getTime()); row.put("lat", fix.getLatitude());
                row.put("lon", fix.getLongitude()); row.put("accuracy", fix.getAccuracy());
                db.insertWithOnConflict("fixes", null, row, SQLiteDatabase.CONFLICT_IGNORE);
            } catch (RuntimeException error) { android.util.Log.w("ImpactLocation", "GPS history could not be saved"); }
        });
    }
    void lookup(long impact, PluginCall call) {
        worker.execute(() -> {
            try {
                long now = System.currentTimeMillis();
                SQLiteDatabase db = getWritableDatabase();
                prune(db, now);
                if (!ImpactLocationPolicy.matches(impact, impact, now)) {
                    call.reject("충격 시각의 GPS 기록이 없습니다 (보관 기간 7일)."); return;
                }
                // Deterministic nearest sample; ties prefer higher accuracy, then the earlier sample.
                try (Cursor c = db.rawQuery("SELECT timestamp, lat, lon, accuracy FROM fixes WHERE timestamp BETWEEN ? AND ? "
                        + "ORDER BY ABS(timestamp - ?), accuracy, timestamp LIMIT 1", new String[] {
                            Long.toString(impact - ImpactLocationPolicy.WINDOW_MS),
                            Long.toString(impact + ImpactLocationPolicy.WINDOW_MS), Long.toString(impact) })) {
                    if (!c.moveToFirst() || !ImpactLocationPolicy.matches(impact, c.getLong(0), now)) {
                        call.reject("충격 시각의 GPS 기록이 없습니다. 영상은 폰에 보관합니다."); return;
                    }
                    JSObject result = new JSObject();
                    result.put("timestamp", c.getLong(0)); result.put("latitude", c.getDouble(1));
                    result.put("longitude", c.getDouble(2)); result.put("accuracy", c.getDouble(3));
                    call.resolve(result);
                }
            } catch (RuntimeException error) { call.reject("충격 시각의 GPS 기록을 읽지 못했습니다."); }
        });
    }
}
