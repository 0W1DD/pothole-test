package com.gimmegimme.pothole;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-private, backup-excluded credentials encrypted with an Android Keystore key. */
final class BlackboxCredentials {
    private static final String KEY = "pothole.blackbox.wifi.v1";
    private final AtomicFile file;

    BlackboxCredentials(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "blackbox-wifi.json"));
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    JSONObject load() throws Exception {
        if (!file.getBaseFile().exists()) return new JSONObject();
        JSONObject stored = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128,
                Base64.decode(stored.getString("iv"), Base64.NO_WRAP)));
        byte[] plain = cipher.doFinal(Base64.decode(stored.getString("data"), Base64.NO_WRAP));
        return new JSONObject(new String(plain, StandardCharsets.UTF_8));
    }

    void save(JSONObject settings) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        JSONObject stored = new JSONObject();
        stored.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
        stored.put("data", Base64.encodeToString(cipher.doFinal(
                settings.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(stored.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(out);
        } catch (Exception error) {
            if (out != null) file.failWrite(out);
            throw error;
        }
    }

    void clear() { file.delete(); }
}
