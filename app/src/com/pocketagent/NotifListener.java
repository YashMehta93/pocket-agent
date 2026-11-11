package com.pocketagent;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Generic capability: read and dismiss the phone's notifications ("notifications.*" in Rpc.java).
 * Off until the user grants notification access in Android settings.
 */
public class NotifListener extends NotificationListenerService {
    static volatile NotifListener instance;

    @Override public void onListenerConnected() { instance = this; }
    @Override public void onListenerDisconnected() { instance = null; }

    JSONArray list() throws Exception {
        JSONArray out = new JSONArray();
        StatusBarNotification[] all = getActiveNotifications();
        if (all == null) return out;
        for (StatusBarNotification s : all) {
            Bundle e = s.getNotification().extras;
            out.put(new JSONObject().put("key", s.getKey()).put("package", s.getPackageName()).put("postTime", s.getPostTime())
                .put("title", String.valueOf(e.getCharSequence(Notification.EXTRA_TITLE, "")))
                .put("text", String.valueOf(e.getCharSequence(Notification.EXTRA_TEXT, "")))
                .put("bigText", String.valueOf(e.getCharSequence(Notification.EXTRA_BIG_TEXT, "")))
                .put("ongoing", s.isOngoing()));
        }
        return out;
    }

    void dismiss(String key) { cancelNotification(key); }
}
