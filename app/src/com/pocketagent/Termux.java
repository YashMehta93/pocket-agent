package com.pocketagent;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

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
