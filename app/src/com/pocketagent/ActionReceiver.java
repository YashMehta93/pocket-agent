package com.pocketagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/** Notification buttons: POSTs the button's body to the server path it names (see Notifier). */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent i) {
        final String path = i.getStringExtra("path"), body = i.getStringExtra("body"), toast = i.getStringExtra("toast");
        Notifier.cancel(ctx, i.getStringExtra("notifId"));
        if (path == null) return;
        final PendingResult pr = goAsync();
        new Thread(() -> {
            boolean ok = false;
            try {
                String sep = path.contains("?") ? "&" : "?";
                URL url = new URL(Prefs.server(ctx) + path + sep + "token=" + URLEncoder.encode(Prefs.serverToken(ctx), "UTF-8"));
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(3000); c.setReadTimeout(8000);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write((body == null ? "{}" : body).getBytes("UTF-8")); }
                ok = c.getResponseCode() == 200;
                c.disconnect();
            } catch (Exception ignored) {}
            final boolean done = ok;
            new Handler(Looper.getMainLooper()).post(() -> {
                Toast.makeText(ctx, done ? (toast != null ? toast : "Done") : "Couldn't reach the server", Toast.LENGTH_SHORT).show();
                pr.finish();
            });
        }).start();
    }
}
