package com.pocketagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Renders notifications from JSON specs, so what to notify about (and how) is decided by the
 * server and can change without reinstalling the app. Spec fields:
 *
 *   id                 string; "status" updates the persistent service notification
 *   channel            "status" | "approval" | "done" | any id; or { id, name, importance: min|low|default|high }
 *   title, text, subText, bigText
 *   ongoing, onlyAlertOnce, silent, autoCancel (default: !ongoing)
 *   chronometerStart   ms timestamp: shows a running timer from then
 *   onlyWhenBackground skip while the app is open on screen
 *   prefKey            skip if the app setting with this key is false (e.g. "notifyApproval")
 *   tap                { sessionId?, action? } opened in the app when tapped
 *   actions            [{ label, post: { path, body }, toast? }]  buttons that POST to the server
 */
final class Notifier {
    static final int ID_STATUS = 1;
    private Notifier() {}

    static int idOf(String id) { return "status".equals(id) ? ID_STATUS : (id == null ? 0 : id.hashCode()); }

    static Notification build(Context c, JSONObject s) {
        String channel = ensureChannel(c, s.opt("channel"));
        Notification.Builder b = new Notification.Builder(c, channel).setSmallIcon(R.drawable.ic_notif);
        if (s.has("title")) b.setContentTitle(s.optString("title"));
        if (s.has("text")) b.setContentText(s.optString("text"));
        if (s.has("subText")) b.setSubText(s.optString("subText"));
        String big = s.optString("bigText", s.optString("text", ""));
        if (!big.isEmpty()) b.setStyle(new Notification.BigTextStyle().bigText(big));
        boolean ongoing = s.optBoolean("ongoing", false);
        b.setOngoing(ongoing).setAutoCancel(s.optBoolean("autoCancel", !ongoing)).setOnlyAlertOnce(s.optBoolean("onlyAlertOnce", false));
        long chrono = s.optLong("chronometerStart", 0);
        if (chrono > 0) b.setWhen(chrono).setShowWhen(true).setUsesChronometer(true);
        JSONObject tap = s.optJSONObject("tap");
        b.setContentIntent(openApp(c, tap, s.optString("id", "")));
        JSONArray actions = s.optJSONArray("actions");
        if (actions != null) for (int i = 0; i < actions.length() && i < 3; i++) {
            JSONObject a = actions.optJSONObject(i);
            if (a == null) continue;
            Intent it = new Intent(c, ActionReceiver.class).putExtra("notifId", s.optString("id", ""));
            JSONObject post = a.optJSONObject("post");
            if (post != null) it.putExtra("path", post.optString("path")).putExtra("body", String.valueOf(post.opt("body")));
            if (a.has("toast")) it.putExtra("toast", a.optString("toast"));
            PendingIntent pi = PendingIntent.getBroadcast(c, (s.optString("id") + i).hashCode(), it, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(new Notification.Action.Builder(null, a.optString("label", "OK"), pi).build());
        }
        return b.build();
    }

    /** Shows (or updates) a notification. Returns false if skipped by its conditions. */
    static boolean show(Context c, JSONObject s) {
        if (s.optBoolean("onlyWhenBackground", false) && MainActivity.foreground) return false;
        String pref = s.optString("prefKey", "");
        if (!pref.isEmpty() && !Prefs.ui(c).optBoolean(pref, true)) return false;
        c.getSystemService(NotificationManager.class).notify(idOf(s.optString("id")), build(c, s));
        return true;
    }

    static void cancel(Context c, String id) {
        if ("status".equals(id)) return;  // the service notification can only be updated, not removed
        c.getSystemService(NotificationManager.class).cancel(idOf(id));
    }

    static String ensureChannel(Context c, Object spec) {
        String id = "default", name = "General";
        int imp = NotificationManager.IMPORTANCE_DEFAULT;
        if (spec instanceof JSONObject) {
            JSONObject o = (JSONObject) spec;
            id = o.optString("id", id); name = o.optString("name", id); imp = importance(o.optString("importance", "default"));
        } else if (spec instanceof String) {
            id = (String) spec;
            switch (id) {
                case "status": name = "Connection & progress"; imp = NotificationManager.IMPORTANCE_MIN; break;
                case "approval": name = "Approvals"; imp = NotificationManager.IMPORTANCE_HIGH; break;
                case "done": name = "Finished tasks"; break;
                default: name = id;
            }
        }
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(id) == null) nm.createNotificationChannel(new NotificationChannel(id, name, imp));
        return id;
    }

    private static int importance(String s) {
        switch (s) {
            case "min": return NotificationManager.IMPORTANCE_MIN;
            case "low": return NotificationManager.IMPORTANCE_LOW;
            case "high": return NotificationManager.IMPORTANCE_HIGH;
            default: return NotificationManager.IMPORTANCE_DEFAULT;
        }
    }

    static PendingIntent openApp(Context c, JSONObject tap, String key) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (tap != null && tap.has("sessionId")) i.putExtra(MainActivity.EXTRA_SESSION, tap.optString("sessionId"));
        if (tap != null && tap.has("action")) i.putExtra(MainActivity.EXTRA_ACTION, tap.optString("action"));
        return PendingIntent.getActivity(c, ("open" + key).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
