package com.pocketagent;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Talks to Termux. Commands go through Termux's RUN_COMMAND service, which needs
 *  - the com.termux.permission.RUN_COMMAND permission (granted to this app at runtime), and
 *  - allow-external-apps = true in ~/.termux/termux.properties.
 */
final class Termux {
    static final String PKG = "com.termux";
    static final String PREFIX = "/data/data/com.termux/files/usr";
    static final String HOME = "/data/data/com.termux/files/home";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";

    private Termux() {}

    static boolean installed(Context c) {
        try { c.getPackageManager().getPackageInfo(PKG, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    static boolean hasPermission(Context c) {
        return c.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Runs a command. background=true runs silently; false opens it in a new Termux terminal tab. */
    static boolean run(Context c, String path, String[] args, String workdir, boolean background) {
        if (!installed(c) || !hasPermission(c)) return false;
        Intent i = new Intent();
        i.setClassName(PKG, "com.termux.app.RunCommandService");
        i.setAction("com.termux.RUN_COMMAND");
        i.putExtra("com.termux.RUN_COMMAND_PATH", path);
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args);
        if (workdir != null) i.putExtra("com.termux.RUN_COMMAND_WORKDIR", workdir);
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background);
        i.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0"); // switch to the new session when shown
        try {
            c.startService(i);
            return true;
        } catch (Exception e) {
            try { c.startForegroundService(i); return true; } catch (Exception e2) { return false; }
        }
    }

    private static final AtomicInteger seq = new AtomicInteger();

    /**
     * Runs `bash -c cmd` in Termux in the background and reports its output: Termux sends the result back
     * through a PendingIntent (stdout/stderr are cut to about 100 KB by Termux). Fails with a hint when
     * Termux is missing, the permission isn't granted, or allow-external-apps is off.
     */
    static void exec(Context c, String cmd, String workdir, long timeoutMs, Rpc.Done d) {
        if (!installed(c)) { d.err("Termux isn't installed"); return; }
        if (!hasPermission(c)) { d.err("Pocket Agent may not run Termux commands yet: allow it in Settings → Termux"); return; }
        String action = c.getPackageName() + ".TERMUX_RESULT." + seq.incrementAndGet();
        AtomicBoolean done = new AtomicBoolean(false);
        Handler h = new Handler(Looper.getMainLooper());
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent in) {
                if (!done.compareAndSet(false, true)) return;
                try { ctx.unregisterReceiver(this); } catch (Exception ignored) {}
                Bundle b = in.getBundleExtra("result");
                if (b == null) { d.err("Termux sent no result"); return; }
                try {
                    String errmsg = b.getString("errmsg");
                    int err = b.getInt("err", -1);
                    if (errmsg != null && !errmsg.isEmpty() && err > 1) { d.err("Termux: " + errmsg.trim()); return; }
                    d.ok(new JSONObject().put("code", b.getInt("exitCode", -1))
                        .put("stdout", b.getString("stdout", "")).put("stderr", b.getString("stderr", "")));
                } catch (Exception e) { d.err(e.toString()); }
            }
        };
        if (android.os.Build.VERSION.SDK_INT >= 33) c.registerReceiver(r, new IntentFilter(action), Context.RECEIVER_NOT_EXPORTED);
        else c.registerReceiver(r, new IntentFilter(action));
        // Termux fills in the result extras, so the PendingIntent must be mutable; it targets only our package.
        PendingIntent pi = PendingIntent.getBroadcast(c, seq.get(), new Intent(action).setPackage(c.getPackageName()),
            PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
        Intent i = new Intent().setClassName(PKG, "com.termux.app.RunCommandService").setAction("com.termux.RUN_COMMAND")
            .putExtra("com.termux.RUN_COMMAND_PATH", PREFIX + "/bin/bash")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", cmd})
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", workdir != null ? workdir : HOME)
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pi);
        try { c.startService(i); }
        catch (Exception e) { try { c.startForegroundService(i); } catch (Exception e2) { done.set(true); try { c.unregisterReceiver(r); } catch (Exception ignored) {} d.err("Couldn't reach Termux: " + e2.getMessage()); return; } }
        h.postDelayed(() -> {
            if (!done.compareAndSet(false, true)) return;
            try { c.unregisterReceiver(r); } catch (Exception ignored) {}
            d.err("No answer from Termux. In Termux run: mkdir -p ~/.termux && echo allow-external-apps=true >> ~/.termux/termux.properties, then restart Termux");
        }, timeoutMs);
    }

    static boolean startServer(Context c, String token) {
        return run(c, PREFIX + "/bin/pocket-agent", new String[]{"start", "--token", token}, HOME, true);
    }

    static boolean restartServer(Context c, String token) {
        return run(c, PREFIX + "/bin/pocket-agent", new String[]{"restart", "--token", token}, HOME, true);
    }

    /** Opens Claude Code in a Termux terminal, resuming the given session. */
    static boolean openClaude(Context c, String cwd, String sessionId) {
        String cmd = "cd " + shellQuote(cwd) + " && exec claude" + (sessionId != null && !sessionId.isEmpty() ? " --resume " + shellQuote(sessionId) : "");
        return run(c, PREFIX + "/bin/bash", new String[]{"-lc", cmd}, cwd, false);
    }

    static void openApp(Activity a) {
        Intent i = a.getPackageManager().getLaunchIntentForPackage(PKG);
        if (i != null) a.startActivity(i);
    }

    static String shellQuote(String s) { return "'" + s.replace("'", "'\\''") + "'"; }
}
