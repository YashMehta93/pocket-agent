// HTTP server: UI files, health, SSE for native notifications, permission replies, WebSocket upgrade.
//   GET  /health               liveness (no auth)
//   GET  /ui/...               the chat UI (no auth; it holds no secrets)
//   WS   /ws?token=…           main app protocol (docs/PROTOCOL.md)
//   GET  /events?token=…       Server-Sent Events for the Android notification service
//   POST /permission?token=…   answer a permission request from a notification button
//   POST /native/result?token= result of a server → phone RPC call (hub.callNative)
//   GET  /apk/download?token=  latest built APK, for in-app updates
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { VERSION, TOKEN, UI_DIR, APK_PATH, safeEq, log } from "./config.js";
import { clients, sseClients, nativeResult } from "./hub.js";
import { toNative } from "./notify.js";
import { toolDetail } from "./activity.js";
import { live, getLive } from "./live-session.js";
import { handlers } from "./handlers.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") { res.setHeader("access-control-allow-origin", "*"); return json(res, 200, { ok: true, version: VERSION, live: live.size }); }
    if (url.pathname === "/" || url.pathname.startsWith("/ui/")) return serveUi(url.pathname, res);
    if (!safeEq(url.searchParams.get("token") || req.headers["x-token"], TOKEN)) return json(res, 401, { error: "bad token" });
    if (url.pathname === "/events") return sse(req, res, +(url.searchParams.get("v") || 1), +(url.searchParams.get("api") || 0));
    if (url.pathname === "/native/result" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      try { return json(res, 200, { ok: nativeResult(JSON.parse(body || "{}")) }); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    }
    if (url.pathname === "/apk/download") {
      try {
        const st = await fsp.stat(APK_PATH);
        res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-length": st.size });
        return fs.createReadStream(APK_PATH).pipe(res);
      } catch { return json(res, 404, { error: "no APK built" }); }
    }
    if (url.pathname === "/permission" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      try { const m = JSON.parse(body || "{}"); return json(res, 200, { ok: getLive(m.sessionId).answer(m) }); }
      catch (e) { return json(res, 400, { error: String(e.message) }); }
    }
    json(res, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws" || !safeEq(url.searchParams.get("token"), TOKEN)) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => onSocket(ws));
  });
  return server;
}

function onSocket(ws) {
  ws.subs = new Set();
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => {});
  ws.on("message", async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const reply = r => ws.readyState === 1 && ws.send(JSON.stringify({ ...r, t: "reply", id: m.id }));
    const h = handlers[m.t];
    if (!h) return reply({ error: `unknown message ${m.t}` });
    try { reply(await h(m, ws) || {}); }
    catch (e) { log("handler error", m.t, e?.message); reply({ error: String(e?.message || e), code: e?.code, kind: e?.kind, short: e?.short }); }
  });
}

/** SSE for the app's background service. v=1: legacy app (raw events); v=2: generic shell (notification specs + rpc). */
function sse(req, res, v, api) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const pending = [...live.values()].flatMap(s => s.info().pending);
  const running = [...live.values()].filter(s => s.state === "running" || s.state === "waiting");
  if (v >= 2) {
    // Catch the phone up: open approvals and current progress, as ready-to-show notifications.
    const events = [
      ...pending.flatMap(p => toNative({ type: "permission.request", ...p, input: toolDetail(p.toolName, p.input) })),
      ...running.flatMap(s => { const a = s.activity.snapshot(); return toNative({ type: "activity", sessionId: s.sessionId, title: s.title, phase: a.phase, label: a.label, detail: a.detail, turnStart: a.turnStart }); }),
    ];
    res.write(`data: ${JSON.stringify({ type: "batch", events })}\n\n`);
  } else {
    const activity = running.map(s => ({ sessionId: s.sessionId, title: s.title, ...s.activity.snapshot(), steps: undefined }));
    res.write(`data: ${JSON.stringify({ type: "hello", pending, activity })}\n\n`);
  }
  const client = { res, v, api };
  sseClients.add(client);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(client); });
}

async function serveUi(p, res) {
  if (p === "/") { res.writeHead(302, { location: "/ui/" }); return res.end(); }
  let rel = decodeURIComponent(p.slice(4)) || "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch { json(res, 404, { error: "not found" }); }
}
