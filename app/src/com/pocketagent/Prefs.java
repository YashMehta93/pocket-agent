package com.pocketagent;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.security.SecureRandom;

/** Small persistent settings shared by the activity and the notification service. */
final class Prefs {
    static final String LOCAL_SERVER = "http://127.0.0.1:8765";
    private Prefs() {}

    private static SharedPreferences sp(Context c) { return c.getSharedPreferences("pa", Context.MODE_PRIVATE); }

    /** Shared secret between this app and the Termux server; generated on first launch. */
    static String token(Context c) {
        String t = sp(c).getString("token", null);
        if (t == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            t = sb.toString();
            sp(c).edit().putString("token", t).apply();
        }
        return t;
    }

    /** UI settings JSON mirrored from the web UI (notification toggles, custom server). */
    static JSONObject ui(Context c) {
        try { return new JSONObject(sp(c).getString("ui", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    static void setUi(Context c, String json) { sp(c).edit().putString("ui", json).apply(); }

    /** Server base URL and token, honouring a custom server set in the app's settings. */
    static String server(Context c) {
        String s = ui(c).optString("server", "");
        return s.isEmpty() ? LOCAL_SERVER : s;
    }
    /** Token typed in by the user (manual pairing or a remote server) wins over the generated one. */
    static String serverToken(Context c) {
        String t = ui(c).optString("token", "");
        return !t.isEmpty() ? t : token(c);
    }
    static boolean notifyApproval(Context c) { return ui(c).optBoolean("notifyApproval", true); }
    static boolean notifyDone(Context c) { return ui(c).optBoolean("notifyDone", true); }
}
