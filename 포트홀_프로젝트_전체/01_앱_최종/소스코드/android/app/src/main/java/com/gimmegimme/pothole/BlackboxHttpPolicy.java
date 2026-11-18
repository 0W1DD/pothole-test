package com.gimmegimme.pothole;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;

/** Shared policy for the local camera endpoint; deliberately no DNS hostnames. */
final class BlackboxHttpPolicy {
    static final int MAX_BYTES = 8 * 1024 * 1024;

    static URL target(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("블랙박스 주소가 필요합니다.");
        URI uri = new URI(value);
        if (!"http".equals(uri.getScheme()) || !"10.42.0.1".equals(uri.getHost())
                || uri.getPort() != 8080 || uri.getRawUserInfo() != null
                || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("http://10.42.0.1:8080 주소만 사용할 수 있습니다.");
        }
        return uri.toURL();
    }

    static byte[] read(InputStream input, int limit, long deadlineNanos) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (input == null) return out.toByteArray();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (System.nanoTime() > deadlineNanos) throw new IOException("응답 시간 초과");
            if (count > limit - out.size()) throw new IOException("응답 크기 제한 초과 (최대 8 MiB)");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}
