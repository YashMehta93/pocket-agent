package com.pocketagent;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Environment;
import android.system.Os;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * The app's own Linux environment (no Termux needed): Alpine Linux run through proot, with
 * Node, git, ripgrep, Claude Code and the Pocket Agent server installed inside it.
 *
 *   files/linux/rootfs      the Alpine root filesystem
 *   files/linux/tmp         proot's scratch dir
 *   files/linux/state.json  which install steps are done (setup resumes where it stopped)
 *   files/linux/*.log       setup and server logs
 *
 * proot ships inside the APK as lib*.so (app/jniLibs), the only place Android lets an app
 * execute files from. The app targets SDK 28 so proot may run binaries from the rootfs.
 */
final class Linux {
    static final int PORT = 8790;
    static final String SERVER_URL = "http://127.0.0.1:" + PORT;
    private static final String ALPINE = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/";
    private static final String PACKAGES = "bash curl git ripgrep nodejs npm libgcc libstdc++ ca-certificates procps zstd jq openssh-client tar xz less";
    private static final String PATH = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

    interface Listener { void onStatus(JSONObject status); }
    interface LineSink { void line(String s); }

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static volatile JSONObject status = new JSONObject();
    private static volatile boolean installing = false;
    private static volatile Process server;
    private static volatile boolean serverWanted = false;
    private static volatile Process login;

    private Linux() {}

    // ───── paths & state ─────
    static File base(Context c) { File f = new File(c.getFilesDir(), "linux"); f.mkdirs(); return f; }
    static File rootfs(Context c) { return new File(base(c), "rootfs"); }
    static File serverLog(Context c) { return new File(base(c), "server.log"); }
    static File setupLog(Context c) { return new File(base(c), "setup.log"); }
    private static File stateFile(Context c) { return new File(base(c), "state.json"); }

    static JSONObject state(Context c) {
        try { return new JSONObject(read(stateFile(c))); } catch (Exception e) { return new JSONObject(); }
    }
    private static void mark(Context c, String key, Object v) {
        try { JSONObject s = state(c); s.put(key, v); write(stateFile(c), s.toString()); } catch (Exception ignored) {}
    }
    /** Setup finished and the Linux system is present. */
    /** Signed in to Claude, as of the last check (the setup screen checks when this is false). */
    static boolean signedIn(Context c) { return state(c).optBoolean("signedIn", false); }
    static boolean installed(Context c) { return state(c).optBoolean("ready", false) && lexists(new File(rootfs(c), "bin/busybox")); }

    /**
     * Whether a path exists *without following symlinks*. Inside the rootfs, links like /bin/sh -> /bin/busybox
     * are absolute and only resolve inside proot; File.exists() would follow them on Android and say false.
     */
    static boolean lexists(File f) { try { Os.lstat(f.getAbsolutePath()); return true; } catch (Exception e) { return false; } }
    /** What each install step must leave behind; checked so a damaged install repairs itself. */
    private static boolean hasRootfs(File r) { return lexists(new File(r, "bin/busybox")) && lexists(new File(r, "etc/alpine-release")); }
    private static boolean hasPackages(File r) { return lexists(new File(r, "usr/bin/node")) && lexists(new File(r, "usr/bin/curl")) && lexists(new File(r, "bin/bash")); }
    private static boolean hasClaude(File r) { return lexists(new File(r, "root/.local/bin/claude")); }

    static JSONObject status() { return status; }
    static void addListener(Listener l) { listeners.add(l); }
    static void removeListener(Listener l) { listeners.remove(l); }

    private static void emit(Context c, String step, String label, int pct, String detail) {
        try {
            JSONObject s = new JSONObject().put("installing", installing).put("installed", installed(c)).put("step", step)
                .put("label", label).put("pct", pct).put("detail", detail == null ? "" : detail).put("server", server != null && server.isAlive());
            status = s;
            for (Listener l : listeners) l.onStatus(s);
        } catch (Exception ignored) {}
    }
    private static void log(Context c, String line) {
        try (FileOutputStream o = new FileOutputStream(setupLog(c), true)) { o.write((line + "\n").getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
    }

    // ───── running commands inside the rootfs ─────
    /** A proot command line. fakeRoot is only for package installs (Claude Code refuses some flags as root). */
    static ProcessBuilder proot(Context c, String shellCmd, boolean fakeRoot, String... env) {
        String lib = c.getApplicationInfo().nativeLibraryDir;
        List<String> cmd = new ArrayList<>();
        cmd.add(lib + "/libproot.so");
        cmd.add("--link2symlink"); cmd.add("--kill-on-exit");
        if (fakeRoot) cmd.add("-0");
        cmd.add("-r"); cmd.add(rootfs(c).getAbsolutePath());
        for (String b : new String[]{"/dev", "/proc", "/sys", "/dev/urandom:/dev/random"}) { cmd.add("-b"); cmd.add(b); }
        File sd = Environment.getExternalStorageDirectory();
        if (sd != null && sd.canRead()) { cmd.add("-b"); cmd.add(sd.getAbsolutePath() + ":/sdcard"); }
        cmd.add("-w"); cmd.add("/root");
        cmd.add("/usr/bin/env"); cmd.add("-i");
        cmd.add("HOME=/root"); cmd.add("USER=" + (fakeRoot ? "root" : "pocket")); cmd.add("LOGNAME=pocket");
        cmd.add("TERM=xterm-256color"); cmd.add("LANG=C.UTF-8"); cmd.add("TMPDIR=/tmp"); cmd.add("PATH=" + PATH);
        cmd.add("USE_BUILTIN_RIPGREP=0"); cmd.add("SHELL=/bin/bash");
        for (String e : env) cmd.add(e);
        cmd.add("/bin/sh"); cmd.add("-c"); cmd.add(shellCmd);
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        File tmp = new File(base(c), "tmp"); tmp.mkdirs();
        pb.environment().put("LD_LIBRARY_PATH", lib);
        pb.environment().put("PROOT_LOADER", lib + "/libproot-loader.so");
        pb.environment().put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        pb.environment().remove("LD_PRELOAD");
        return pb;
    }

    /** Runs a command to completion, streaming output lines; returns the exit code. */
    static int run(Context c, String cmd, boolean fakeRoot, LineSink sink, long timeoutMs) throws Exception {
        Process p = proot(c, cmd, fakeRoot).start();
        p.getOutputStream().close();
        Thread reader = new Thread(() -> pump(p.getInputStream(), sink));
        reader.start();
        if (!p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) { p.destroyForcibly(); throw new IOException("Timed out: " + cmd); }
        reader.join(2000);
        return p.exitValue();
    }
    /** Runs a command and returns its output (for small commands). */
    static String capture(Context c, String cmd, long timeoutMs) throws Exception {
        StringBuilder sb = new StringBuilder();
        run(c, cmd, false, s -> sb.append(s).append('\n'), timeoutMs);
        return sb.toString();
    }
    private static void pump(InputStream in, LineSink sink) {
        try (InputStream i = in) {
            java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream(); int b;
            while ((b = i.read()) != -1) {
                if (b == '\n') { if (sink != null) sink.line(line.toString("UTF-8").replace("\r", "")); line.reset(); } else line.write(b);
            }
            if (line.size() > 0 && sink != null) sink.line(line.toString("UTF-8"));
        } catch (IOException ignored) {}
    }

    // ───── install (idempotent; each step recorded in state.json) ─────
    static void installAsync(Context c) {
        if (installing) return;
        installing = true;
        new Thread(() -> {
            try { install(c); }
            catch (Exception e) { log(c, "FAILED: " + e); emit(c, "error", "Setup stopped", -1, String.valueOf(e.getMessage())); }
            finally { installing = false; }
        }, "pa-install").start();
    }

    private static void install(Context c) throws Exception {
        long free = c.getFilesDir().getUsableSpace() / (1024 * 1024);
        log(c, "=== setup " + new java.util.Date() + " free=" + free + "MB");
        if (!state(c).optBoolean("rootfs") && free < 1200) throw new IOException("Not enough space: " + free + " MB free, about 1.2 GB needed");
        JSONObject st = state(c);
        File r = rootfs(c);

        if (!st.optBoolean("rootfs") || !hasRootfs(r)) {
            // a fresh rootfs invalidates everything installed into the old one
            mark(c, "packages", false); mark(c, "claude", false); mark(c, "ready", false);
            new File(rootfs(c).getParentFile(), "rootfs/opt/pocket-agent/bundle.json").delete();
            emit(c, "rootfs", "Downloading Linux", 2, "Alpine Linux base system");
            String yaml = httpText(ALPINE + "latest-releases.yaml");
            Matcher m = Pattern.compile("file:\\s*(alpine-minirootfs-[0-9.]+-aarch64\\.tar\\.gz)[\\s\\S]*?sha256:\\s*([0-9a-f]{64})").matcher(yaml);
            if (!m.find()) throw new IOException("Couldn't find the Alpine download");
            File tgz = new File(c.getCacheDir(), m.group(1));
            download(c, ALPINE + m.group(1), tgz, m.group(2), "rootfs", "Downloading Linux", 2, 8);
            emit(c, "rootfs", "Unpacking Linux", 9, m.group(1));
            deleteTree(r); r.mkdirs();
            untarGz(tgz, r);
            tgz.delete();
            write(new File(r, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
            write(new File(r, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n");
            int uid = android.os.Process.myUid();
            append(new File(r, "etc/passwd"), "pocket:x:" + uid + ":" + uid + ":Pocket Agent:/root:/bin/bash\n");
            append(new File(r, "etc/group"), "pocket:x:" + uid + ":\n");
            new File(r, "root").mkdirs(); new File(r, "tmp").mkdirs();
            mark(c, "rootfs", true);
        }

        if (!state(c).optBoolean("packages") || !hasPackages(r)) {
            mark(c, "claude", false);
            emit(c, "packages", "Installing tools", 12, "Node.js, git, ripgrep, bash");
            int code = run(c, "apk update && apk add --no-cache " + PACKAGES, true, s -> { log(c, s); emit(c, "packages", "Installing tools", 30, s); }, 15 * 60_000);
            if (code != 0) throw new IOException("Installing tools failed (exit " + code + "). Check your connection and retry.");
            // Resilient curl: abort stalled transfers, retry, and resume file downloads (the Claude installer uses curl).
            write(new File(r, "usr/local/bin/curl"), "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = \"-o\" ] && RESUME=\"-C -\"; done\n"
                + "exec /usr/bin/curl --retry 10 --retry-all-errors --retry-delay 2 --connect-timeout 15 --speed-limit 4096 --speed-time 20 $RESUME \"$@\"\n");
            Os.chmod(new File(r, "usr/local/bin/curl").getAbsolutePath(), 0755);
            mark(c, "packages", true);
        }

        if (!state(c).optBoolean("claude") || !hasClaude(r)) {
            emit(c, "claude", "Installing Claude Code", 40, "Official installer from claude.ai");
            int code = run(c, "curl -fsSL https://claude.ai/install.sh | bash", false, s -> { log(c, s); emit(c, "claude", "Installing Claude Code", 60, s); }, 20 * 60_000);
            String v = capture(c, "claude --version", 60_000).trim();
            log(c, "claude --version: " + v);
            if (code != 0 || !v.contains("Claude Code")) throw new IOException("Installing Claude Code failed. Retry in a moment.");
            mark(c, "claude", true);
        }

        syncBundle(c, true);
        mark(c, "ready", true);
        emit(c, "done", "Ready", 100, "");
        startServer(c);
    }

    /**
     * Copies the server + UI bundled in this APK into the rootfs when the APK changed
     * (so app updates also update the server), and runs npm install when dependencies changed.
     */
    static synchronized void syncBundle(Context c, boolean reportProgress) throws Exception {
        AssetManager am = c.getAssets();
        String bundled = readAsset(am, "bundle.json");
        File dest = new File(rootfs(c), "opt/pocket-agent");
        File marker = new File(dest, "bundle.json");
        // Written only after npm install succeeds, with the dependency files it installed from;
        // a half-finished install (app killed mid-way) therefore reruns instead of being trusted.
        File depsMarker = new File(dest, "server/.deps-installed");
        if (marker.exists() && bundled.equals(read(marker)) && depsMarker.exists()) return;
        if (reportProgress) emit(c, "server", "Setting up Pocket Agent", 85, "Copying the server");
        deleteTree(new File(dest, "server/src")); deleteTree(new File(dest, "app"));
        copyAssets(am, "server", new File(dest, "server"));
        copyAssets(am, "ui", new File(dest, "app/assets/ui"));
        File lock = new File(dest, "server/package-lock.json");
        String deps = read(new File(dest, "server/package.json")) + (lock.exists() ? read(lock) : "");
        if (!depsMarker.exists() || !deps.equals(read(depsMarker))) {
            depsMarker.delete();
            if (reportProgress) emit(c, "server", "Setting up Pocket Agent", 90, "Installing server packages");
            int code = run(c, "cd /opt/pocket-agent/server && npm install --omit=optional --no-audit --no-fund", false, s -> log(c, s), 15 * 60_000);
            if (code != 0) throw new IOException("Installing server packages failed (exit " + code + ")");
            write(depsMarker, deps);
        }
        Os.chmod(new File(dest, "server/bin/pocket-agent").getAbsolutePath(), 0755);
        write(marker, bundled);
    }

    // ───── server supervision ─────
    static synchronized void startServer(Context c) {
        serverWanted = true;
        if (server != null && server.isAlive()) return;
        if (!installed(c)) return;
        new Thread(() -> {
            long backoff = 1000;
            while (serverWanted) {
                try {
                    syncBundle(c, false);
                    ProcessBuilder pb = proot(c, "cd /opt/pocket-agent/server && exec node src/index.js --port " + PORT
                        + " --host 127.0.0.1 --claude /root/.local/bin/claude --token " + Prefs.token(c), false,
                        "PA_SUPERVISED=1", "PA_DATA=/root/.pocket-agent", "PA_MODE=standalone");
                    pb.redirectOutput(ProcessBuilder.Redirect.appendTo(serverLog(c)));
                    long t0 = System.currentTimeMillis();
                    Process p = pb.start();
                    server = p;
                    emit(c, "server", "Starting", 100, "");
                    p.waitFor();
                    server = null;
                    if (System.currentTimeMillis() - t0 > 60_000) backoff = 1000;   // ran fine for a while: restart quickly
                } catch (Exception e) { log(c, "server: " + e); }
                if (!serverWanted) break;
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { break; }
                backoff = Math.min(backoff * 2, 30_000);
            }
        }, "pa-server").start();
    }
    static void stopServer() { serverWanted = false; Process p = server; if (p != null) p.destroy(); }
    static void restartServer() { Process p = server; if (p != null) p.destroy(); }   // the supervisor restarts it
    static boolean serverAlive() { Process p = server; return p != null && p.isAlive(); }

    // ───── sign-in (Claude Code's own login: URL in, pasted code out) ─────
    static String loginStart(Context c) throws Exception {
        if (login != null && login.isAlive()) login.destroy();
        Process p = proot(c, "exec claude auth login --claudeai", false).start();
        login = p;
        final StringBuilder out = new StringBuilder();
        final String[] url = {null};
        Thread t = new Thread(() -> {
            try (InputStream in = p.getInputStream()) {
                int b;
                while ((b = in.read()) != -1) {
                    synchronized (out) { out.append((char) b); }
                    // Match only once the URL is complete (followed by whitespace): output arrives byte by byte.
                    Matcher m = Pattern.compile("(https://\\S+oauth/authorize\\S+)\\s").matcher(out);
                    if (url[0] == null && m.find()) { synchronized (url) { url[0] = m.group(1); url.notifyAll(); } }
                }
            } catch (IOException ignored) {}
            synchronized (url) { url.notifyAll(); }
        });
        t.start();
        synchronized (url) { if (url[0] == null) url.wait(30_000); }
        if (url[0] == null) throw new IOException("Claude didn't provide a sign-in link: " + out.toString().trim());
        return url[0];
    }
    /** Sends the code from the browser; returns auth status JSON once Claude has finished. */
    static JSONObject loginCode(Context c, String code) throws Exception {
        Process p = login;
        if (p == null || !p.isAlive()) throw new IOException("Start sign-in again");
        OutputStream o = p.getOutputStream();
        o.write((code.trim() + "\n").getBytes(StandardCharsets.UTF_8)); o.flush();
        if (!p.waitFor(90, java.util.concurrent.TimeUnit.SECONDS)) { p.destroy(); throw new IOException("Sign-in timed out"); }
        login = null;
        JSONObject s = authStatus(c);
        if (!s.optBoolean("loggedIn")) throw new IOException("Sign-in didn't complete. Copy the whole code and try again.");
        restartServer();
        return s;
    }
    static JSONObject authStatus(Context c) throws Exception {
        String out = capture(c, "claude auth status --json", 60_000);
        int i = out.indexOf('{');
        JSONObject s = i >= 0 ? new JSONObject(out.substring(i, out.lastIndexOf('}') + 1)) : new JSONObject().put("loggedIn", false).put("error", out.trim());
        mark(c, "signedIn", s.optBoolean("loggedIn"));   // lets the app open straight into chats next time
        return s;
    }

    static void reset(Context c) { stopServer(); deleteTree(base(c)); }

    // ───── downloads, archives, files ─────
    private static String httpText(String url) throws IOException {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(15_000); h.setReadTimeout(30_000);
        try (InputStream in = h.getInputStream()) { return new String(readAll(in), StandardCharsets.UTF_8); } finally { h.disconnect(); }
    }

    /** Download with resume, stall detection (20 s read timeout), retries and sha256 check. */
    private static void download(Context c, String url, File dest, String sha256, String step, String label, int from, int to) throws Exception {
        Exception last = null;
        for (int attempt = 1; attempt <= 10; attempt++) {
            try {
                long have = dest.exists() ? dest.length() : 0;
                HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
                h.setConnectTimeout(15_000); h.setReadTimeout(20_000);
                if (have > 0) h.setRequestProperty("Range", "bytes=" + have + "-");
                int code = h.getResponseCode();
                boolean append = code == 206;
                if (!append) have = 0;
                if (code != 200 && code != 206) throw new IOException("HTTP " + code);
                long total = have + Math.max(0, h.getContentLengthLong());
                try (InputStream in = new BufferedInputStream(h.getInputStream()); OutputStream out = new FileOutputStream(dest, append)) {
                    byte[] buf = new byte[65536]; int n; long got = have, lastEmit = 0;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n); got += n;
                        if (System.currentTimeMillis() - lastEmit > 400) {
                            lastEmit = System.currentTimeMillis();
                            int pct = total > 0 ? from + (int) ((to - from) * got / total) : from;
                            emit(c, step, label, pct, (got / 1048576) + " / " + (total / 1048576) + " MB");
                        }
                    }
                }
                if (sha256 != null && !sha256.equalsIgnoreCase(sha256(dest))) { dest.delete(); throw new IOException("Download was corrupted"); }
                return;
            } catch (Exception e) {
                last = e; log(c, "download attempt " + attempt + ": " + e);
                emit(c, step, label, from, "Connection problem, retrying (" + attempt + "/10)");
                Thread.sleep(Math.min(2000L * attempt, 15_000));
            }
        }
        throw last;
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) md.update(b, 0, n); }
        StringBuilder sb = new StringBuilder(); for (byte x : md.digest()) sb.append(String.format("%02x", x)); return sb.toString();
    }

    /** Unpacks a .tar.gz with Android file APIs (see Tar.java). */
    static void untarGz(File tgz, File dest) throws Exception {
        Tar.extractGz(tgz, dest, new Tar.Fs() {
            @Override public void symlink(String target, String path) throws Exception { Os.symlink(target, path); }
            @Override public void chmod(String path, int mode) { try { Os.chmod(path, mode); } catch (Exception ignored) {} }
        });
    }

    private static void copyAssets(AssetManager am, String from, File to) throws IOException {
        String[] list = am.list(from);
        if (list == null || list.length == 0) {   // a file
            to.getParentFile().mkdirs();
            try (InputStream in = am.open(from); OutputStream o = new FileOutputStream(to)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); }
            return;
        }
        to.mkdirs();
        for (String n : list) copyAssets(am, from + "/" + n, new File(to, n));
    }
    private static String readAsset(AssetManager am, String name) { try (InputStream in = am.open(name)) { return new String(readAll(in), StandardCharsets.UTF_8); } catch (IOException e) { return ""; } }
    private static byte[] readAll(InputStream in) throws IOException { java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream(); byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); return o.toByteArray(); }
    static String read(File f) throws IOException { try (InputStream in = new FileInputStream(f)) { return new String(readAll(in), StandardCharsets.UTF_8); } }
    static String tail(File f, int maxBytes) {
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r")) {
            long start = Math.max(0, r.length() - maxBytes); r.seek(start);
            byte[] b = new byte[(int) (r.length() - start)]; r.readFully(b); return new String(b, StandardCharsets.UTF_8);
        } catch (IOException e) { return ""; }
    }
    private static void write(File f, String s) throws IOException { f.getParentFile().mkdirs(); try (OutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); } }
    private static void append(File f, String s) throws IOException { try (OutputStream o = new FileOutputStream(f, true)) { o.write(s.getBytes(StandardCharsets.UTF_8)); } }
    static void deleteTree(File f) {
        if (f == null || !lexists(f)) return;
        try {
            boolean link = android.system.OsConstants.S_ISLNK(Os.lstat(f.getAbsolutePath()).st_mode);
            if (f.isDirectory() && !link) { File[] k = f.listFiles(); if (k != null) for (File x : k) deleteTree(x); }
        } catch (Exception ignored) {}
        f.delete();
    }
}
