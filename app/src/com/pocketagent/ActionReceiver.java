package com.pocketagent;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/** Handles Allow / Deny taps on approval notifications. */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        final String sid = i.getStringExtra("sessionId"), rid = i.getStringExtra("requestId"), behavior = i.getStringExtra("behavior");
        ctx.getSystemService(NotificationManager.class).cancel(rid.hashCode());
        final PendingResult pr = goAsync();
        new Thread(() -> {
            boolean ok = false;
            try {
                String url = Prefs.server(ctx) + "/permission?token=" + URLEncoder.encode(Prefs.serverToken(ctx), "UTF-8");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(3000); c.setReadTimeout(5000);
                c.setRequestProperty("content-type", "application/json");
                byte[] body = new JSONObject().put("sessionId", sid).put("requestId", rid).put("behavior", behavior).toString().getBytes("UTF-8");
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
                ok = c.getResponseCode() == 200;
                c.disconnect();
            } catch (Exception ignored) {}
            final boolean done = ok;
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                Toast.makeText(ctx, done ? ("allow".equals(behavior) ? "Allowed" : "Denied") : "Couldn't reach the server", Toast.LENGTH_SHORT).show();
                pr.finish();
            });
        }).start();
    }
}
