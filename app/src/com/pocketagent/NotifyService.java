package com.pocketagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * Keeps a Server-Sent Events connection to the bridge server so Claude can reach you
 * while the app is in the background: approval requests (with Allow / Deny buttons)
 * and "finished" notifications.
 */
public class NotifyService extends Service {
    static final String CH_STATUS = "status", CH_APPROVAL = "approval", CH_DONE = "done";
    private static final int ID_STATUS = 1;
    private volatile boolean running = false;
    private Thread worker;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel s = new NotificationChannel(CH_STATUS, "Connection", NotificationManager.IMPORTANCE_MIN);
        s.setDescription("Shown while Pocket Agent listens for Claude in the background");
        NotificationChannel a = new NotificationChannel(CH_APPROVAL, "Approvals", NotificationManager.IMPORTANCE_HIGH);
        a.setDescription("Claude needs your OK to run a command or edit a file");
        NotificationChannel d = new NotificationChannel(CH_DONE, "Finished tasks", NotificationManager.IMPORTANCE_DEFAULT);
        d.setDescription("Claude finished working");
        nm.createNotificationChannel(s); nm.createNotificationChannel(a); nm.createNotificationChannel(d);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new Notification.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_notif).setContentTitle("Pocket Agent").setContentText("Listening for Claude")
            .setContentIntent(openApp(this, null, 0)).setOngoing(true).build();
        try {
            if (android.os.Build.VERSION.SDK_INT >= 34) startForeground(ID_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID_STATUS, n);
        } catch (Exception e) { /* notification permission missing: keep running without foreground */ }
        if (!running) { running = true; worker = new Thread(this::loop, "pa-sse"); worker.start(); }
        return START_STICKY;
    }

    @Override public void onDestroy() { running = false; if (worker != null) worker.interrupt(); super.onDestroy(); }

    private void loop() {
        long backoff = 2000;
        while (running) {
            HttpURLConnection c = null;
            try {
                String url = Prefs.server(this) + "/events?token=" + URLEncoder.encode(Prefs.serverToken(this), "UTF-8");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(3000); c.setReadTimeout(70_000);
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                backoff = 2000;
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"));
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.startsWith("data: ")) handle(new JSONObject(line.substring(6)));
                }
            } catch (Exception e) {
                // server not running yet, or connection dropped: retry with backoff
            } finally { if (c != null) c.disconnect(); }
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 60_000);
        }
    }

    private void handle(JSONObject ev) {
        String type = ev.optString("type");
        NotificationManager nm = getSystemService(NotificationManager.class);
        switch (type) {
            case "hello": {
                JSONArray p = ev.optJSONArray("pending");
                if (p != null) for (int i = 0; i < p.length(); i++) approval(p.optJSONObject(i));
                break;
            }
            case "permission.request": approval(ev); break;
            case "permission.resolved": nm.cancel(ev.optString("requestId").hashCode()); break;
            case "done": {
                if (!Prefs.notifyDone(this) || MainActivity.foreground) break;
                String sid = ev.optString("sessionId");
                Notification n = new Notification.Builder(this, CH_DONE).setSmallIcon(R.drawable.ic_notif)
                    .setContentTitle("Done: " + ev.optString("title", "Claude"))
                    .setContentText(ev.optString("text"))
                    .setStyle(new Notification.BigTextStyle().bigText(ev.optString("text")))
                    .setAutoCancel(true).setContentIntent(openApp(this, sid, sid.hashCode())).build();
                nm.notify(("done" + sid).hashCode(), n);
                break;
            }
        }
    }

    private void approval(JSONObject p) {
        if (p == null || !Prefs.notifyApproval(this) || MainActivity.foreground) return;
        String rid = p.optString("requestId"), sid = p.optString("sessionId"), tool = p.optString("toolName");
        Object inp = p.opt("input");
        String detail = inp instanceof JSONObject ? summarize(tool, (JSONObject) inp) : String.valueOf(inp == null ? "" : inp);
        String title = "AskUserQuestion".equals(tool) ? "Claude has a question" : "ExitPlanMode".equals(tool) ? "Claude's plan is ready" : "Allow " + tool + "?";
        Notification.Builder b = new Notification.Builder(this, CH_APPROVAL).setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title).setContentText(detail).setSubText(p.optString("title", ""))
            .setStyle(new Notification.BigTextStyle().bigText(detail))
            .setCategory(Notification.CATEGORY_MESSAGE).setAutoCancel(true)
            .setContentIntent(openApp(this, sid, rid.hashCode()));
        // Questions and plans need the full UI; simple approvals can be answered right here.
        if (!"AskUserQuestion".equals(tool) && !"ExitPlanMode".equals(tool)) {
            b.addAction(new Notification.Action.Builder(null, "Allow", action(sid, rid, "allow")).build());
            b.addAction(new Notification.Action.Builder(null, "Deny", action(sid, rid, "deny")).build());
        }
        getSystemService(NotificationManager.class).notify(rid.hashCode(), b.build());
    }

    private static String summarize(String tool, JSONObject in) {
        if (in.has("command")) return in.optString("command");
        if (in.has("file_path")) return in.optString("file_path");
        if (in.has("url")) return in.optString("url");
        String s = in.toString();
        return s.length() > 300 ? s.substring(0, 300) : s;
    }

    private PendingIntent action(String sid, String rid, String behavior) {
        Intent i = new Intent(this, ActionReceiver.class).putExtra("sessionId", sid).putExtra("requestId", rid).putExtra("behavior", behavior);
        return PendingIntent.getBroadcast(this, (rid + behavior).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent openApp(Context c, String sessionId, int code) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null) i.putExtra(MainActivity.EXTRA_SESSION, sessionId);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
