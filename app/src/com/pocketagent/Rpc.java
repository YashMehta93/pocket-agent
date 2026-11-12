package com.pocketagent;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.util.DisplayMetrics;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * Every native capability, behind one method-name dispatcher. Called by:
 *   - the UI:     window.PA.rpc(id, method, paramsJson)   → result via paNative.emit("rpc", …)
 *   - the server: SSE { type: "rpc", id, method, params } → result POSTed to /native/result
 * New features should be built on the server/UI side out of these primitives, so they ship
 * without reinstalling the app. Add a native method only for a genuinely new capability.
 */
final class Rpc {
    /** Bump when methods are added; the server/UI can check it via "capabilities". */
    static final int API_VERSION = 2;   // 2: runtime.* (built-in Linux) and mode.set

    interface Done { void ok(Object result); void err(String message); }

    private static final Handler ui = new Handler(Looper.getMainLooper());
    private static TextToSpeech tts;

    static final String[] METHODS = {
        "capabilities", "device.info", "notify", "notify.cancel", "toast", "vibrate", "clipboard.get", "clipboard.set",
        "share.text", "url.open", "intent.start", "app.list", "app.launch", "permissions.check", "permissions.request",
        "settings.open", "location.get", "tts.speak", "update.install", "termux.run",
        "a11y.status", "a11y.tree", "a11y.click", "a11y.long_click", "a11y.set_text", "a11y.scroll", "a11y.global", "a11y.gesture", "a11y.screenshot",
        "notifications.list", "notifications.dismiss",
        "runtime.status", "runtime.install", "runtime.auth", "runtime.login.start", "runtime.login.code", "runtime.logs",
        "runtime.restart", "runtime.start", "runtime.reset", "runtime.exec", "mode.set",
    };

    private Rpc() {}

    static void call(Context c, String method, JSONObject p, Done d) {
        try { dispatch(c.getApplicationContext(), method, p == null ? new JSONObject() : p, d); }
        catch (Exception e) { d.err(e.getClass().getSimpleName() + ": " + e.getMessage()); }
    }

    private static void dispatch(Context c, String m, JSONObject p, Done d) throws Exception {
        switch (m) {
            case "capabilities": {
                JSONArray a = new JSONArray(); for (String s : METHODS) a.put(s);
                d.ok(new JSONObject().put("api", API_VERSION).put("methods", a)
                    .put("accessibility", A11yService.instance != null).put("notificationAccess", NotifListener.instance != null));
                return;
            }
            case "device.info": {
                BatteryManager bm = c.getSystemService(BatteryManager.class);
                DisplayMetrics dm = c.getResources().getDisplayMetrics();
                d.ok(new JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("android", Build.VERSION.RELEASE)
                    .put("sdk", Build.VERSION.SDK_INT).put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                    .put("charging", bm.isCharging()).put("screen", new JSONArray().put(dm.widthPixels).put(dm.heightPixels))
                    .put("density", dm.density).put("locale", Locale.getDefault().toString()));
                return;
            }
            case "notify": d.ok(Notifier.show(c, p)); return;
            case "notify.cancel": Notifier.cancel(c, p.optString("id")); d.ok(true); return;
            case "toast": ui.post(() -> Toast.makeText(c, p.optString("text"), p.optBoolean("long") ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show()); d.ok(true); return;
            case "vibrate": {
                Vibrator v = c.getSystemService(Vibrator.class);
                v.vibrate(VibrationEffect.createOneShot(Math.max(10, p.optLong("ms", 40)), VibrationEffect.DEFAULT_AMPLITUDE));
                d.ok(true); return;
            }
            case "clipboard.get": ui.post(() -> {
                ClipboardManager cm = c.getSystemService(ClipboardManager.class);
                ClipData clip = cm.getPrimaryClip();
                d.ok(clip != null && clip.getItemCount() > 0 ? String.valueOf(clip.getItemAt(0).coerceToText(c)) : "");
            }); return;
            case "clipboard.set": ui.post(() -> { c.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Pocket Agent", p.optString("text"))); d.ok(true); }); return;
            case "share.text": {
                Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, p.optString("text"));
                if (p.has("title")) i.putExtra(Intent.EXTRA_SUBJECT, p.optString("title"));
                start(c, Intent.createChooser(i, "Share")); d.ok(true); return;
            }
            case "url.open": start(c, new Intent(Intent.ACTION_VIEW, Uri.parse(p.optString("url")))); d.ok(true); return;
            case "intent.start": start(c, intentFrom(p)); d.ok(true); return;
            case "app.list": {
                PackageManager pm = c.getPackageManager();
                List<ResolveInfo> apps = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
                JSONArray a = new JSONArray();
                for (ResolveInfo r : apps) a.put(new JSONObject().put("package", r.activityInfo.packageName).put("label", String.valueOf(r.loadLabel(pm)))
                    .put("system", (r.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0));
                d.ok(a); return;
            }
            case "app.launch": {
                Intent i = c.getPackageManager().getLaunchIntentForPackage(p.optString("package"));
                if (i == null) { d.err("No launchable app " + p.optString("package")); return; }
                start(c, i); d.ok(true); return;
            }
            case "permissions.check": {
                JSONObject r = new JSONObject(); JSONArray names = p.optJSONArray("names");
                if (names != null) for (int k = 0; k < names.length(); k++) r.put(names.optString(k), c.checkSelfPermission(names.optString(k)) == PackageManager.PERMISSION_GRANTED);
                r.put("notifications", c.getSystemService(NotificationManager.class).areNotificationsEnabled());
                r.put("accessibility", A11yService.instance != null).put("notificationAccess", NotifListener.instance != null);
                r.put("installPackages", c.getPackageManager().canRequestPackageInstalls());
                d.ok(r); return;
            }
            case "permissions.request": {
                MainActivity a = MainActivity.current();
                if (a == null) { d.err("Open the app to grant permissions"); return; }
                JSONArray names = p.optJSONArray("names"); String[] arr = new String[names == null ? 0 : names.length()];
                for (int k = 0; k < arr.length; k++) arr[k] = names.optString(k);
                a.requestPerms(arr, d); return;
            }
            case "settings.open": start(c, settingsIntent(c, p.optString("screen", "app"))); d.ok(true); return;
            case "location.get": location(c, d); return;
            case "tts.speak": speak(c, p.optString("text"), d); return;
            case "update.install": Updater.install(c, p.optString("url", "/apk/download"), d); return;
            case "termux.run": {
                JSONArray a = p.optJSONArray("args"); String[] args = new String[a == null ? 0 : a.length()];
                for (int k = 0; k < args.length; k++) args[k] = a.optString(k);
                d.ok(Termux.run(c, p.optString("path"), args, p.optString("workdir", null), p.optBoolean("background", true))); return;
            }
            case "notifications.list": { NotifListener l = NotifListener.instance; if (l == null) { d.err("Notification access is off"); return; } d.ok(l.list()); return; }
            case "notifications.dismiss": { NotifListener l = NotifListener.instance; if (l == null) { d.err("Notification access is off"); return; } l.dismiss(p.optString("key")); d.ok(true); return; }
        }
        if (m.startsWith("a11y.")) { a11y(m.substring(5), p, d); return; }
        if (m.startsWith("runtime.") || m.equals("mode.set")) { runtime(c, m, p, d); return; }
        d.err("Unknown method " + m + " (this app version supports: capabilities)");
    }

    private static void a11y(String m, JSONObject p, Done d) throws Exception {
        A11yService s = A11yService.instance;
        if (m.equals("status")) { d.ok(s != null); return; }
        if (s == null) { d.err("Accessibility is off. Enable Pocket Agent in Settings → Accessibility."); return; }
        JSONObject target = p.optJSONObject("target"); if (target == null) target = new JSONObject();
        switch (m) {
            case "tree": d.ok(s.tree(p.optInt("max", 400))); return;
            case "click": s.click(target, false, d); return;
            case "long_click": s.click(target, true, d); return;
            case "set_text": d.ok(s.setText(target, p.optString("text"))); return;
            case "scroll": d.ok(s.scroll(target, !"backward".equals(p.optString("direction", "forward")))); return;
            case "global": d.ok(s.global(p.optString("action"))); return;
            case "gesture": {
                JSONArray pts = p.optJSONArray("points"); int[][] arr = new int[pts.length()][2];
                for (int k = 0; k < arr.length; k++) { JSONArray xy = pts.getJSONArray(k); arr[k][0] = xy.getInt(0); arr[k][1] = xy.getInt(1); }
                if (!s.gesture(arr, p.optLong("duration", 300), d)) d.err("Gesture was rejected");
                return;
            }
            case "screenshot": s.screenshot(p.optInt("maxSide", 1280), d); return;
        }
        d.err("Unknown method a11y." + m);
    }

    /** The built-in Linux environment (Linux.java). Slow calls run on their own thread. */
    private static void runtime(Context c, String m, JSONObject p, Done d) throws Exception {
        switch (m) {
            case "runtime.status": {
                JSONObject s = new JSONObject().put("standalone", Prefs.standalone(c)).put("installed", Linux.installed(c))
                    .put("state", Linux.state(c)).put("progress", Linux.status()).put("serverAlive", Linux.serverAlive())
                    .put("freeMB", c.getFilesDir().getUsableSpace() / 1048576).put("serverUrl", Linux.SERVER_URL);
                d.ok(s); return;
            }
            case "runtime.install": Linux.installAsync(c); d.ok(true); return;
            case "runtime.restart": Linux.restartServer(); d.ok(true); return;
            case "runtime.start": Linux.startServer(c); d.ok(true); return;
            case "runtime.reset": Linux.reset(c); d.ok(true); return;
            case "runtime.logs": d.ok(Linux.tail("server".equals(p.optString("which")) ? Linux.serverLog(c) : Linux.setupLog(c), p.optInt("bytes", 20000))); return;
            case "mode.set": {
                JSONObject ui = Prefs.ui(c);
                ui.put("server", p.optString("server", "")).put("token", p.optString("token", ""));
                Prefs.setUi(c, ui.toString());
                MainActivity a = MainActivity.current(); if (a != null) a.boot();
                d.ok(true); return;
            }
        }
        new Thread(() -> {
            try {
                switch (m) {
                    case "runtime.auth": d.ok(Linux.authStatus(c)); return;
                    case "runtime.login.start": d.ok(new JSONObject().put("url", Linux.loginStart(c))); return;
                    case "runtime.login.code": d.ok(Linux.loginCode(c, p.optString("code"))); return;
                    case "runtime.exec": d.ok(Linux.capture(c, p.optString("cmd"), p.optLong("timeoutMs", 60_000))); return;
                    default: d.err("Unknown method " + m);
                }
            } catch (Exception e) { d.err(String.valueOf(e.getMessage())); }
        }, "pa-rpc-" + m).start();
    }

    // ───── helpers ─────
    private static void start(Context c, Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity a = MainActivity.current();
        if (a != null) a.runOnUiThread(() -> a.startActivity(i)); else c.startActivity(i);
    }

    /** { action, data, type, package, className, categories[], extras{}, flags } */
    static Intent intentFrom(JSONObject p) throws Exception {
        Intent i = new Intent();
        if (p.has("action")) i.setAction(p.optString("action"));
        if (p.has("data") && p.has("type")) i.setDataAndType(Uri.parse(p.optString("data")), p.optString("type"));
        else if (p.has("data")) i.setData(Uri.parse(p.optString("data")));
        else if (p.has("type")) i.setType(p.optString("type"));
        if (p.has("package") && p.has("className")) i.setComponent(new ComponentName(p.optString("package"), p.optString("className")));
        else if (p.has("package")) i.setPackage(p.optString("package"));
        JSONArray cats = p.optJSONArray("categories");
        if (cats != null) for (int k = 0; k < cats.length(); k++) i.addCategory(cats.optString(k));
        JSONObject ex = p.optJSONObject("extras");
        if (ex != null) for (Iterator<String> it = ex.keys(); it.hasNext(); ) {
            String k = it.next(); Object v = ex.get(k);
            if (v instanceof Boolean) i.putExtra(k, (Boolean) v); else if (v instanceof Integer) i.putExtra(k, (Integer) v);
            else if (v instanceof Long) i.putExtra(k, (Long) v); else if (v instanceof Double) i.putExtra(k, (Double) v); else i.putExtra(k, String.valueOf(v));
        }
        if (p.has("flags")) i.addFlags(p.optInt("flags"));
        return i;
    }

    private static Intent settingsIntent(Context c, String screen) {
        switch (screen) {
            case "accessibility": return new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            case "notification_access": return new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            case "notifications": return new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
            case "unknown_sources": return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName()));
            case "battery": return new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            case "developer": return new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
            default: return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
        }
    }

    private static void location(Context c, Done d) throws Exception {
        if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
            && c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            d.err("Location permission not granted (call permissions.request with android.permission.ACCESS_FINE_LOCATION)"); return;
        }
        LocationManager lm = c.getSystemService(LocationManager.class);
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
        if (Build.VERSION.SDK_INT >= 30) {
            lm.getCurrentLocation(provider, null, c.getMainExecutor(), loc -> {
                try { if (loc == null) d.err("No location fix"); else d.ok(locJson(loc)); } catch (Exception e) { d.err(e.getMessage()); }
            });
        } else {
            Location l = lm.getLastKnownLocation(provider);
            if (l == null) d.err("No location fix"); else d.ok(locJson(l));
        }
    }
    private static JSONObject locJson(Location l) throws Exception {
        return new JSONObject().put("lat", l.getLatitude()).put("lon", l.getLongitude()).put("accuracy", l.getAccuracy()).put("time", l.getTime());
    }

    private static void speak(Context c, String text, Done d) {
        ui.post(() -> {
            if (tts == null) tts = new TextToSpeech(c, status -> {
                if (status == TextToSpeech.SUCCESS) { tts.speak(text, TextToSpeech.QUEUE_ADD, null, "pa"); d.ok(true); } else d.err("Text-to-speech unavailable");
            });
            else { tts.speak(text, TextToSpeech.QUEUE_ADD, null, "pa"); d.ok(true); }
        });
    }
}
