package com.pocketagent;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.security.SecureRandom;

/**
 * Small persistent settings shared by the activity and the background service.
 *
 * Two modes:
 *  - standalone (default): the app runs its own Linux + server (Linux.java) at Linux.SERVER_URL
 *  - server: the user set a server address in Settings (Termux on this phone, a PC, …)
 */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences sp(Context c) { return c.getSharedPreferences("pa", Context.MODE_PRIVATE); }

    /** Shared secret between this app and its built-in server; generated on first launch. */
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

    /** UI settings JSON mirrored from the web UI (notification toggles, server address). */
    static JSONObject ui(Context c) {
        try { return new JSONObject(sp(c).getString("ui", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    static void setUi(Context c, String json) { sp(c).edit().putString("ui", json).apply(); }

    static boolean standalone(Context c) { return ui(c).optString("server", "").isEmpty(); }

    static String server(Context c) { return standalone(c) ? Linux.SERVER_URL : ui(c).optString("server"); }

    static String serverToken(Context c) {
        String t = ui(c).optString("token", "");
        return !standalone(c) && !t.isEmpty() ? t : token(c);
    }

    static boolean notifyApproval(Context c) { return ui(c).optBoolean("notifyApproval", true); }
    static boolean notifyDone(Context c) { return ui(c).optBoolean("notifyDone", true); }
}
