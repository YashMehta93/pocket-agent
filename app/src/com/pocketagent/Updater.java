package com.pocketagent;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * In-app updates: downloads a new APK from the server and hands it to Android's installer,
 * which shows one confirmation dialog. Needs "Install unknown apps" allowed for Pocket Agent
 * (we open that setting the first time).
 */
final class Updater {
    private Updater() {}

    static void install(Context c, String path, Rpc.Done done) {
        if (!c.getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(s);
            done.err("Allow \"Install unknown apps\" for Pocket Agent, then tap Update again.");
            return;
        }
        new Thread(() -> {
            try {
                String sep = path.contains("?") ? "&" : "?";
                URL url = new URL(path.startsWith("http") ? path : Prefs.server(c) + path + sep + "token=" + URLEncoder.encode(Prefs.serverToken(c), "UTF-8"));
                HttpURLConnection h = (HttpURLConnection) url.openConnection();
                h.setConnectTimeout(5000); h.setReadTimeout(60000);
                if (h.getResponseCode() != 200) throw new Exception("Download failed (HTTP " + h.getResponseCode() + ")");
                PackageInstaller pi = c.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(c.getPackageName());
                int id = pi.createSession(params);
                try (PackageInstaller.Session s = pi.openSession(id)) {
                    try (InputStream in = h.getInputStream(); OutputStream out = s.openWrite("update.apk", 0, -1)) {
                        byte[] buf = new byte[65536]; int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        s.fsync(out);
                    }
                    Intent cb = new Intent(c, Status.class);
                    s.commit(PendingIntent.getBroadcast(c, id, cb, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE).getIntentSender());
                }
                done.ok(true);
            } catch (Exception e) { done.err(String.valueOf(e.getMessage())); }
        }).start();
    }

    /** Receives the installer's status; shows the system confirmation dialog when asked to. */
    public static class Status extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } else if (status != PackageInstaller.STATUS_SUCCESS) {
                Toast.makeText(c, "Update failed: " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), Toast.LENGTH_LONG).show();
            }
        }
    }
}
