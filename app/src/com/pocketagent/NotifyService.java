package com.pocketagent;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Keeps a Server-Sent Events connection to the server while the app is in the background.
 * Generic on purpose: the server sends
 *   { type: "notify", spec }        show/update a notification (see Notifier)
 *   { type: "cancel", id }          remove one
 *   { type: "rpc", id, method, params }  run a native capability (see Rpc); result goes to POST /native/result
 * so notification content and phone features evolve on the server without app updates.
 */
public class NotifyService extends Service {
    private volatile boolean running = false;
    private Thread worker;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n;
        try { n = Notifier.build(this, new JSONObject().put("id", "status").put("channel", "status").put("title", "Pocket Agent").put("text", "Listening for Claude").put("ongoing", true)); }
        catch (Exception e) { return START_STICKY; }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 34) startForeground(Notifier.ID_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(Notifier.ID_STATUS, n);
        } catch (Exception e) { /* no notification permission yet: keep running in the background */ }
        if (!running) { running = true; worker = new Thread(this::loop, "pa-sse"); worker.start(); }
        // This foreground service also keeps the built-in server alive while the app is in the background.
        if (Prefs.standalone(this) && Linux.installed(this)) Linux.startServer(this);
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }

    private void loop() {
        long backoff = 2000;
        while (running) {
            HttpURLConnection c = null;
            try {
                String url = Prefs.server(this) + "/events?v=2&api=" + Rpc.API_VERSION + "&token=" + URLEncoder.encode(Prefs.serverToken(this), "UTF-8");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(3000); c.setReadTimeout(70_000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                backoff = 2000;
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.startsWith("data: ")) {
                        try { handle(new JSONObject(line.substring(6))); } catch (Exception ignored) {}
                    }
                }
            } catch (Exception e) {
                // server not running yet or connection dropped; retry with backoff
            } finally { if (c != null) c.disconnect(); }
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 30_000);
        }
    }

    private void handle(JSONObject ev) {
        switch (ev.optString("type")) {
            case "notify": { JSONObject spec = ev.optJSONObject("spec"); if (spec != null) Notifier.show(this, spec); break; }
            case "cancel": Notifier.cancel(this, ev.optString("id")); break;
            case "batch": { JSONArray a = ev.optJSONArray("events"); if (a != null) for (int i = 0; i < a.length(); i++) handle(a.optJSONObject(i)); break; }
            case "rpc": {
                final String id = ev.optString("id");
                Rpc.call(this, ev.optString("method"), ev.optJSONObject("params"), new Rpc.Done() {
                    @Override public void ok(Object result) { postResult(id, result, null); }
                    @Override public void err(String message) { postResult(id, null, message); }
                });
                break;
            }
        }
    }

    private void postResult(String id, Object result, String error) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("id", id);
                if (error != null) body.put("error", error); else body.put("result", result == null ? JSONObject.NULL : result);
                URL url = new URL(Prefs.server(this) + "/native/result?token=" + URLEncoder.encode(Prefs.serverToken(this), "UTF-8"));
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST"); c.setDoOutput(true); c.setConnectTimeout(3000); c.setReadTimeout(10000);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes("UTF-8")); }
                c.getResponseCode(); c.disconnect();
            } catch (Exception ignored) {}
        }).start();
    }
}
