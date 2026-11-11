package com.pocketagent;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.speech.RecognizerIntent;
import android.util.Base64;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    static volatile boolean foreground = false;
    static final String EXTRA_SESSION = "com.pocketagent.SESSION";
    static final String EXTRA_ACTION = "com.pocketagent.ACTION";

    private static final int REQ_FILES = 1, REQ_VOICE = 2, REQ_PHOTO = 3, REQ_PERMS = 4;
    private static final int MAX_SHARE_BYTES = 20 * 1024 * 1024;

    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private Uri photoUri;
    private boolean pageReady = false;
    private String pendingIntentJson;
    private String loadedFrom = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1f1e1c"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "PA");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if (host.equals("127.0.0.1") || u.getScheme().equals("file") || Prefs.server(MainActivity.this).contains(host)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = p.createIntent();
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(i, REQ_FILES); } catch (Exception e) { fileCallback = null; return false; }
                return true;
            }
        });
        setContentView(web);
        requestRuntimePermissions();
        startService(new Intent(this, NotifyService.class));
        handleIntent(getIntent());
        boot();
    }

    /** Load the UI from the Termux server (so UI updates need no reinstall); fall back to the bundled copy. */
    private void boot() {
        new Thread(() -> {
            String server = Prefs.server(this);
            boolean up = healthy(server);
            if (!up && server.equals(Prefs.LOCAL_SERVER)) {
                Termux.startServer(this, Prefs.token(this));
                for (int i = 0; i < 40 && !up; i++) { sleep(250); up = healthy(server); }
            }
            final String url = up ? server + "/ui/" : "file:///android_asset/ui/index.html";
            ui.post(() -> { loadedFrom = url; web.loadUrl(url); });
        }).start();
    }

    static boolean healthy(String server) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(server + "/health").openConnection();
            c.setConnectTimeout(1200); c.setReadTimeout(1500);
            boolean ok = c.getResponseCode() == 200;
            c.disconnect();
            return ok;
        } catch (Exception e) { return false; }
    }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

    private void requestRuntimePermissions() {
        List<String> want = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) want.add("android.permission.POST_NOTIFICATIONS");
        if (Termux.installed(this) && !Termux.hasPermission(this)) want.add(Termux.PERMISSION);
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_PERMS && Termux.hasPermission(this)) {
            new Thread(() -> { if (!healthy(Prefs.LOCAL_SERVER)) { Termux.startServer(this, Prefs.token(this)); sleep(3000); ui.post(() -> { if (loadedFrom.startsWith("file:")) boot(); }); } }).start();
        }
    }

    @Override protected void onResume() { super.onResume(); foreground = true; }
    @Override protected void onPause() { super.onPause(); foreground = false; }
    @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); handleIntent(i); }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.paBack ? paBack() : false", r -> { if (!"true".equals(r)) moveTaskToBack(true); });
    }

    // ───────────── intents: share sheet, notifications, shortcuts ─────────────
    private void handleIntent(Intent i) {
        if (i == null) return;
        new Thread(() -> {
            try {
                JSONObject o = null;
                String a = i.getAction();
                if (i.hasExtra(EXTRA_SESSION)) {
                    o = new JSONObject().put("action", "open").put("sessionId", i.getStringExtra(EXTRA_SESSION));
                } else if (i.hasExtra(EXTRA_ACTION)) {
                    o = new JSONObject().put("action", i.getStringExtra(EXTRA_ACTION));
                } else if (Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a)) {
                    o = new JSONObject().put("action", "share");
                    StringBuilder text = new StringBuilder();
                    CharSequence subj = i.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
                    CharSequence t = i.getCharSequenceExtra(Intent.EXTRA_TEXT);
                    if (subj != null) text.append(subj).append("\n");
                    if (t != null) text.append(t);
                    o.put("text", text.toString().trim());
                    List<Uri> uris = new ArrayList<>();
                    if (Intent.ACTION_SEND.equals(a)) { Uri u = i.getParcelableExtra(Intent.EXTRA_STREAM); if (u != null) uris.add(u); }
                    else { ArrayList<Uri> l = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (l != null) uris.addAll(l); }
                    JSONArray files = new JSONArray();
                    for (Uri u : uris) { JSONObject f = readUri(u); if (f != null) files.put(f); }
                    o.put("files", files);
                }
                if (o != null) { final String json = o.toString(); ui.post(() -> deliverIntent(json)); }
            } catch (Exception e) { toast("Couldn't read shared content"); }
        }).start();
        setIntent(new Intent(this, MainActivity.class));
    }
    private void deliverIntent(String json) { if (pageReady) emit("intent", json); else pendingIntentJson = json; }

    private JSONObject readUri(Uri u) {
        try (InputStream in = getContentResolver().openInputStream(u)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536]; int n; int total = 0;
            while ((n = in.read(buf)) > 0) { total += n; if (total > MAX_SHARE_BYTES) { toast("File too large to share (max 20 MB)"); return null; } out.write(buf, 0, n); }
            String name = "file";
            try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {}
            String type = getContentResolver().getType(u);
            return new JSONObject().put("name", name).put("mediaType", type == null ? "application/octet-stream" : type)
                .put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } catch (Exception e) { return null; }
    }

    // ───────────── activity results: file chooser, voice, camera ─────────────
    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILES && fileCallback != null) {
            Uri[] result = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    ClipData cd = data.getClipData();
                    result = new Uri[cd.getItemCount()];
                    for (int k = 0; k < cd.getItemCount(); k++) result[k] = cd.getItemAt(k).getUri();
                } else if (data.getData() != null) result = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (req == REQ_VOICE) {
            if (res == RESULT_OK && data != null) {
                ArrayList<String> r = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (r != null && !r.isEmpty()) emit("voice", JSONObject.quote(r.get(0)));
            }
        } else if (req == REQ_PHOTO) {
            final Uri u = photoUri; photoUri = null;
            if (res == RESULT_OK && u != null) new Thread(() -> {
                try {
                    String json = encodePhoto(u);
                    getContentResolver().delete(u, null, null);
                    ui.post(() -> emit("photo", json));
                } catch (Exception e) { toast("Couldn't read the photo"); }
            }).start();
            else if (u != null) try { getContentResolver().delete(u, null, null); } catch (Exception ignored) {}
        }
    }

    /** Downscales a camera photo to at most 1600px and returns {name, mediaType, data} as JSON. */
    private String encodePhoto(Uri u) throws Exception {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(u)) { BitmapFactory.decodeStream(in, null, o); }
        int sample = 1;
        while (Math.max(o.outWidth, o.outHeight) / sample > 1600) sample *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = sample;
        Bitmap bmp;
        try (InputStream in = getContentResolver().openInputStream(u)) { bmp = BitmapFactory.decodeStream(in, null, o2); }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
        return new JSONObject().put("name", "photo.jpg").put("mediaType", "image/jpeg")
            .put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).toString();
    }

    private void emit(String name, String json) {
        web.evaluateJavascript("window.paNative && paNative.emit(" + JSONObject.quote(name) + "," + JSONObject.quote(json) + ")", null);
    }
    private void toast(String m) { ui.post(() -> Toast.makeText(this, m, Toast.LENGTH_SHORT).show()); }

    // ───────────── JavaScript bridge (window.PA) ─────────────
    private class Bridge {
        @JavascriptInterface public String token() { return Prefs.serverToken(MainActivity.this); }
        @JavascriptInterface public String serverUrl() { return Prefs.server(MainActivity.this); }
        @JavascriptInterface public String appVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }
        @JavascriptInterface public void ready() {
            ui.post(() -> { pageReady = true; if (pendingIntentJson != null) { emit("intent", pendingIntentJson); pendingIntentJson = null; } });
        }
        @JavascriptInterface public void ensureServer() {
            if (!Prefs.server(MainActivity.this).equals(Prefs.LOCAL_SERVER)) return;
            if (!Termux.installed(MainActivity.this)) { toast("Termux is not installed"); return; }
            if (!Termux.hasPermission(MainActivity.this)) { ui.post(MainActivity.this::requestRuntimePermissions); return; }
            if (!Termux.startServer(MainActivity.this, Prefs.token(MainActivity.this)))
                toast("Couldn't start the server. In Termux run: pocket-agent start");
        }
        @JavascriptInterface public void restartServer() { Termux.restartServer(MainActivity.this, Prefs.token(MainActivity.this)); }
        @JavascriptInterface public void openTermux() { ui.post(() -> Termux.openApp(MainActivity.this)); }
        @JavascriptInterface public void openInTermux(String cwd, String sessionId) {
            if (!Termux.openClaude(MainActivity.this, cwd, sessionId)) { toast("Allow Pocket Agent to run Termux commands first"); ui.post(() -> Termux.openApp(MainActivity.this)); }
        }
        @JavascriptInterface public void haptic(String kind) {
            ui.post(() -> web.performHapticFeedback("long".equals(kind) ? HapticFeedbackConstants.LONG_PRESS
                : "alert".equals(kind) ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.CLOCK_TICK));
        }
        @JavascriptInterface public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("Pocket Agent", text));
        }
        @JavascriptInterface public void share(String text, String title) {
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
            if (title != null && !title.isEmpty()) i.putExtra(Intent.EXTRA_SUBJECT, title);
            ui.post(() -> startActivity(Intent.createChooser(i, "Share")));
        }
        @JavascriptInterface public void startVoice() {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to Claude");
            ui.post(() -> { try { startActivityForResult(i, REQ_VOICE); } catch (Exception e) { toast("No speech recognizer on this device"); } });
        }
        @JavascriptInterface public void takePhoto() {
            ui.post(() -> {
                try {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Images.Media.DISPLAY_NAME, "pocket-agent-" + System.currentTimeMillis() + ".jpg");
                    v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Pocket Agent");
                    photoUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    startActivityForResult(new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, photoUri), REQ_PHOTO);
                } catch (Exception e) { toast("Camera not available"); }
            });
        }
        @JavascriptInterface public void setTheme(String mode, String bg) {
            ui.post(() -> {
                try {
                    int color = Color.parseColor(bg.trim());
                    getWindow().setStatusBarColor(color);
                    getWindow().setNavigationBarColor(color);
                    web.setBackgroundColor(color);
                    WindowInsetsController c = getWindow().getInsetsController();
                    if (c != null) {
                        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        c.setSystemBarsAppearance("light".equals(mode) ? light : 0, light);
                    }
                } catch (Exception ignored) {}
            });
        }
        @JavascriptInterface public void settingsChanged(String json) { Prefs.setUi(MainActivity.this, json); }
        @JavascriptInterface public void setBackHandler(boolean on) { /* back is always routed through paBack() */ }
    }
}
