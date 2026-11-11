package com.pocketagent;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * Generic phone-control capability: read the screen, tap, type, scroll, swipe, press
 * back/home, screenshot. It holds no logic of its own; the server decides what to do
 * and calls these through RPC ("a11y.*" in Rpc.java). Off until the user enables it in
 * Android Settings → Accessibility.
 */
public class A11yService extends AccessibilityService {
    static volatile A11yService instance;

    @Override protected void onServiceConnected() { instance = this; }
    @Override public boolean onUnbind(android.content.Intent i) { instance = null; return super.onUnbind(i); }
    @Override public void onAccessibilityEvent(AccessibilityEvent e) {}
    @Override public void onInterrupt() {}

    // ───── reading the screen ─────

    /** Interesting nodes of the active window, each with an index usable as a target. */
    JSONObject tree(int max) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        JSONObject out = new JSONObject();
        JSONArray nodes = new JSONArray();
        if (root == null) return out.put("package", JSONObject.NULL).put("nodes", nodes);
        out.put("package", String.valueOf(root.getPackageName()));
        List<AccessibilityNodeInfo> all = flatten(root);
        for (int i = 0; i < all.size() && nodes.length() < max; i++) {
            AccessibilityNodeInfo n = all.get(i);
            CharSequence text = n.getText(), desc = n.getContentDescription();
            boolean interesting = text != null || desc != null || n.isClickable() || n.isEditable() || n.isScrollable() || n.isCheckable();
            if (!interesting || !n.isVisibleToUser()) continue;
            Rect r = new Rect(); n.getBoundsInScreen(r);
            JSONObject o = new JSONObject().put("i", i).put("cls", simple(n.getClassName()));
            if (text != null) o.put("text", text.toString());
            if (desc != null) o.put("desc", desc.toString());
            if (n.getViewIdResourceName() != null) o.put("id", n.getViewIdResourceName());
            o.put("bounds", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom));
            if (n.isClickable()) o.put("click", true);
            if (n.isEditable()) o.put("edit", true);
            if (n.isScrollable()) o.put("scroll", true);
            if (n.isCheckable()) o.put("checked", n.isChecked());
            if (n.isFocused()) o.put("focused", true);
            nodes.put(o);
        }
        return out.put("nodes", nodes);
    }

    private static String simple(CharSequence c) { if (c == null) return ""; String s = c.toString(); return s.substring(s.lastIndexOf('.') + 1); }

    private List<AccessibilityNodeInfo> flatten(AccessibilityNodeInfo root) {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        while (!q.isEmpty() && out.size() < 3000) {
            AccessibilityNodeInfo n = q.poll();
            out.add(n);
            for (int k = 0; k < n.getChildCount(); k++) { AccessibilityNodeInfo ch = n.getChild(k); if (ch != null) q.add(ch); }
        }
        return out;
    }

    /** Target: { index } from tree(), or { text } / { desc } / { id } (first match, substring for text/desc). */
    AccessibilityNodeInfo find(JSONObject t) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        List<AccessibilityNodeInfo> all = flatten(root);
        if (t.has("index")) { int i = t.optInt("index"); return i >= 0 && i < all.size() ? all.get(i) : null; }
        String text = t.optString("text", null), desc = t.optString("desc", null), id = t.optString("id", null);
        for (AccessibilityNodeInfo n : all) {
            if (id != null && id.equals(n.getViewIdResourceName())) return n;
            if (text != null && n.getText() != null && n.getText().toString().toLowerCase().contains(text.toLowerCase())) return n;
            if (desc != null && n.getContentDescription() != null && n.getContentDescription().toString().toLowerCase().contains(desc.toLowerCase())) return n;
        }
        return null;
    }

    // ───── acting ─────

    boolean click(JSONObject t, boolean longPress, Rpc.Done done) {
        if (t.has("x") && t.has("y")) { return gesture(new int[][]{{t.optInt("x"), t.optInt("y")}}, longPress ? 700 : 60, done); }
        AccessibilityNodeInfo n = find(t);
        if (n == null) { done.err("No matching element on screen"); return false; }
        AccessibilityNodeInfo c = n;
        while (c != null && !(longPress ? c.isLongClickable() : c.isClickable())) c = c.getParent();
        if (c != null && c.performAction(longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK)) { done.ok(true); return true; }
        Rect r = new Rect(); n.getBoundsInScreen(r);   // not clickable: tap its centre instead
        return gesture(new int[][]{{r.centerX(), r.centerY()}}, longPress ? 700 : 60, done);
    }

    boolean setText(JSONObject t, String text) {
        AccessibilityNodeInfo n = t.length() == 0 ? findFocus(AccessibilityNodeInfo.FOCUS_INPUT) : find(t);
        if (n == null) return false;
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
    }

    boolean scroll(JSONObject t, boolean forward) {
        AccessibilityNodeInfo n = t.length() == 0 ? null : find(t);
        if (n == null) { AccessibilityNodeInfo root = getRootInActiveWindow(); if (root != null) for (AccessibilityNodeInfo x : flatten(root)) if (x.isScrollable()) { n = x; break; } }
        while (n != null && !n.isScrollable()) n = n.getParent();
        return n != null && n.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
    }

    boolean global(String action) {
        int a;
        switch (action) {
            case "back": a = GLOBAL_ACTION_BACK; break;
            case "home": a = GLOBAL_ACTION_HOME; break;
            case "recents": a = GLOBAL_ACTION_RECENTS; break;
            case "notifications": a = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": a = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "power_dialog": a = GLOBAL_ACTION_POWER_DIALOG; break;
            case "lock": a = GLOBAL_ACTION_LOCK_SCREEN; break;
            case "screenshot": a = GLOBAL_ACTION_TAKE_SCREENSHOT; break;
            default: return false;
        }
        return performGlobalAction(a);
    }

    /** One point = tap; several = swipe along the path. */
    boolean gesture(int[][] pts, long durationMs, Rpc.Done done) {
        Path p = new Path();
        p.moveTo(pts[0][0], pts[0][1]);
        for (int i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
        GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, durationMs))).build();
        return dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { done.ok(true); }
            @Override public void onCancelled(GestureDescription d) { done.err("Gesture was cancelled"); }
        }, null);
    }

    void screenshot(int maxSide, Rpc.Done done) {
        if (Build.VERSION.SDK_INT < 30) { done.err("Screenshots need Android 11+"); return; }
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult r) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                    Bitmap bmp = hw.copy(Bitmap.Config.ARGB_8888, false);
                    r.getHardwareBuffer().close();
                    float scale = Math.min(1f, (float) maxSide / Math.max(bmp.getWidth(), bmp.getHeight()));
                    if (scale < 1f) bmp = Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * scale), Math.round(bmp.getHeight() * scale), true);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 80, out);
                    done.ok(new JSONObject().put("mediaType", "image/jpeg").put("width", bmp.getWidth()).put("height", bmp.getHeight())
                        .put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)));
                } catch (Exception e) { done.err(String.valueOf(e.getMessage())); }
            }
            @Override public void onFailure(int code) { done.err("Screenshot failed (" + code + ")"); }
        });
    }
}
