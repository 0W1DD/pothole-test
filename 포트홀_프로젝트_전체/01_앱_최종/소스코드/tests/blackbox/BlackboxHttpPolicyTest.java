package com.gimmegimme.pothole;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

/** Run with a desktop JDK; tests the production allowlist and bounded response reader. */
public final class BlackboxHttpPolicyTest {
    private static int checks;
    interface Operation { void run() throws Exception; }
    private static void rejects(Operation operation) throws Exception {
        try { operation.run(); } catch (Exception expected) { checks++; return; }
        throw new AssertionError("Expected rejection");
    }
    public static void main(String[] args) throws Exception {
        for (String path : new String[] { "/index.json", "/photos/a.jpg", "/photos/%ED%8F%AC.jpg?x=1" }) {
            if (!BlackboxHttpPolicy.target("http://10.42.0.1:8080" + path).getHost().equals("10.42.0.1"))
                throw new AssertionError();
            checks++;
        }
        for (String value : new String[] { null, "", "/index.json", "https://10.42.0.1:8080/index.json",
                "http://10.42.0.1/index.json", "http://10.42.0.1:80/a", "http://10.42.0.2:8080/a",
                "http://example.com:8080/a", "http://10.42.0.1.evil.example:8080/a", "file:///etc/passwd",
                "http://10.42.0.1:8080@evil.example/a", "http://user@10.42.0.1:8080/a",
                "http://10.42.0.1:8080/#fragment", "http://10.42.0.1:8080/\r\nHost: evil",
                "http://10.42.0.1:8080\\@evil.example/", "http://0x0a2a0001:8080/a",
                "http://[::ffff:10.42.0.1]:8080/a" }) {
            rejects(() -> BlackboxHttpPolicy.target(value));
        }
        byte[] input = "hello".getBytes(StandardCharsets.UTF_8);
        byte[] output = BlackboxHttpPolicy.read(new ByteArrayInputStream(input), 5,
                System.nanoTime() + TimeUnit.SECONDS.toNanos(5));
        if (!Arrays.equals(input, output)) throw new AssertionError("Exact limit rejected");
        checks++;
        rejects(() -> BlackboxHttpPolicy.read(new ByteArrayInputStream(input), 4, Long.MAX_VALUE));
        rejects(() -> BlackboxHttpPolicy.read(new ByteArrayInputStream(input), 5, System.nanoTime() - 1));
        if (BlackboxHttpPolicy.read(null, 0, Long.MAX_VALUE).length != 0) throw new AssertionError();
        checks++;
        System.out.println("BlackboxHttpPolicy: " + checks + " checks passed");
    }
}
