// HTTP server: UI files, health, SSE for native notifications, permission replies, WebSocket upgrade.
//   GET  /health               liveness (no auth)
//   GET  /ui/...               the chat UI (no auth; it holds no secrets)
//   WS   /ws?token=…           main app protocol (docs/PROTOCOL.md)
//   GET  /events?token=…       Server-Sent Events for the Android notification service
//   POST /permission?token=…   answer a permission request from a notification button
//   POST /native/result?token= result of a server → phone RPC call (hub.callNative)
//   GET  /apk/download?token=  latest built APK, for in-app updates
//   GET  /bundle/info, /bundle.tgz, /export/sessions.tgz (?token=)  for another server's update / chat import
//   GET  /export/migration.tgz (?token=)  the whole home for a migration; Termux servers only (#65)
//   POST /devices/redeem       (no token) exchange a pairing code for a device token (devices.js)
//   POST /devices/pair?token=  (owner) start pairing: a one-use code for another device
//   GET  /termux/install.sh, /termux/bundle.tgz (?code=)  Termux setup, with a 30-minute code (termux.js)
//   POST /deepseek/v1/messages[/count_tokens]  the DeepSeek key keeper (deepseek.js): DeepSeek chats only, with their
//                              own per-chat token instead of the app token
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { VERSION, UI_DIR, APK_PATH, APK_INFO, CLAUDE_DIR, prefs, log } from "./config.js";
import { bundleInfo, bundleStream, tarStream, pickRelease, releaseAsset } from "./transfer.js";
import { migrationStream } from "./migrate.js";
import { clients, sseClients, nativeResult } from "./hub.js";
import { toNative } from "./notify.js";
import { toolDetail } from "./activity.js";
import { live, getLive } from "./live-session.js";
import { handlers } from "./handlers.js";
import { validCode, installScript } from "./termux.js";
import { proxy as dsProxy } from "./deepseek.js";
import { PROTOCOL, environment } from "./environment.js";
import { authenticate, allowed, startPairing, redeem } from "./devices.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") { res.setHeader("access-control-allow-origin", "*"); return json(res, 200, { ok: true, version: VERSION, live: live.size, protocol: PROTOCOL, env: environment().id }); }
    if (url.pathname === "/" || url.pathname.startsWith("/ui/")) return serveUi(url.pathname, res);
    if (url.pathname.startsWith("/deepseek/")) return dsProxy(req, res, url);   // checks its own per-chat tokens
    if (url.pathname.startsWith("/termux/")) {
      const code = url.searchParams.get("code");
      if (!validCode(code)) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("echo 'This setup command has expired. Get a new one in Pocket Agent: Settings → Termux.' >&2; exit 1\n"); }
      if (url.pathname === "/termux/install.sh") { res.writeHead(200, { "content-type": "text/x-shellscript" }); return res.end(await installScript(code)); }
      if (url.pathname === "/termux/bundle.tgz") { res.writeHead(200, { "content-type": "application/gzip" }); return bundleStream().pipe(res); }
    }
    // A hub redeems its one-time code here, with no token yet: that is what gives it one.
    if (url.pathname === "/devices/redeem" && req.method === "POST") {
      let body;
      try { body = JSON.parse((await readBody(req, 4096)) || "{}"); }
      catch (e) { return json(res, e.code === "too_large" ? 413 : 400, { error: e.code === "too_large" ? "Body too large" : "Send JSON: { code, name }" }); }
      try { return json(res, 200, redeem(body.code, body.name)); }
      catch (e) { return json(res, e.code === "locked" ? 429 : 403, { error: String(e.message) }); }   // never echo the code
    }
    const who = authenticate(url.searchParams.get("token") || req.headers["x-token"]);
    if (!who) return json(res, 401, { error: "bad token" });
    // A device reaches only what its scopes allow; everything else behind the token check is the owner's.
    if (who.kind === "device") {
      const need = { "/export/sessions.tgz": "export.sessions", "/bundle/info": "update.source", "/bundle.tgz": "update.source" }[url.pathname];
      if (!need || !who.scopes.includes(need)) return json(res, 403, { error: "forbidden" });
    }
    // The owner starts pairing here (the CLI in server/src/pair-cli.js prints the code).
    if (url.pathname === "/devices/pair") {
      let body = {};
      if (req.method === "POST") {
        try { body = JSON.parse((await readBody(req, 4096)) || "{}"); }
        catch (e) { return json(res, e.code === "too_large" ? 413 : 400, { error: e.code === "too_large" ? "Body too large" : "Send JSON: { name, scopes }" }); }
      }
      const qscopes = url.searchParams.get("scopes");
      try {
        return json(res, 200, await startPairing({
          name: body.name ?? url.searchParams.get("name") ?? undefined,
          scopes: body.scopes ?? (qscopes ? qscopes.split(",") : undefined),
        }));
      } catch (e) { return json(res, 400, { error: String(e.message) }); }
    }
    if (url.pathname === "/events") return sse(req, res, +(url.searchParams.get("v") || 1), +(url.searchParams.get("api") || 0));
    if (url.pathname === "/native/result" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      try { return json(res, 200, { ok: nativeResult(JSON.parse(body || "{}")) }); } catch (e) { return json(res, 400, { error: String(e.message) }); }
    }
    // Sources for another server's chat import / update channel (see transfer.js).
    if (url.pathname === "/bundle/info") return json(res, 200, await bundleInfo());
    if (url.pathname === "/apk/info") { try { return json(res, 200, JSON.parse(await fsp.readFile(APK_INFO, "utf8"))); } catch { return json(res, 200, { versionCode: 0 }); } }
    if (url.pathname === "/bundle.tgz") { res.writeHead(200, { "content-type": "application/gzip" }); return bundleStream().pipe(res); }
    if (url.pathname === "/export/migration.tgz") {
      // The whole home leaves the phone only from the server it was made for: a Termux install. Pocket
      // Agent's built-in Linux (or any other server) must never stream it out. See issue #65.
      if (!(process.env.PREFIX || "").includes("com.termux")) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Only a Termux server exports its home."); }
      res.writeHead(200, { "content-type": "application/gzip" }); return (await migrationStream()).pipe(res);
    }
    // Every project's chats, for another server's import. Still scoped by the app token; scoped device tokens come later (#65).
    if (url.pathname === "/export/sessions.tgz") { res.writeHead(200, { "content-type": "application/gzip" }); return tarStream(CLAUDE_DIR, ["projects"]).pipe(res); }
    if (url.pathname === "/apk/download") {
      try {
        // the APK built in a local update folder (app's built-in server) or next to this server (Termux)
        if (prefs.updateChannel?.github) {   // stream the APK of the release this app follows (stable, beta or pinned)
          const r = await releaseAsset(prefs.updateChannel, await pickRelease(prefs.updateChannel), "pocket-agent.apk");
          res.writeHead(200, { "content-type": "application/vnd.android.package-archive", ...(r.headers.get("content-length") ? { "content-length": r.headers.get("content-length") } : {}) });
          for await (const chunk of r.body) res.write(chunk);
          return res.end();
        }
        const apk = prefs.updateChannel?.path ? path.join(prefs.updateChannel.path, "build/pocket-agent.apk") : APK_PATH;
        const st = await fsp.stat(apk);
        res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-length": st.size });
        return fs.createReadStream(apk).pipe(res);
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
    const who = url.pathname === "/ws" ? authenticate(url.searchParams.get("token")) : null;
    if (!who) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, ws => onSocket(ws, who));
  });
  return server;
}

function onSocket(ws, principal) {
  ws.principal = principal;   // who is on the other end: the owner, or a paired device with its scopes
  ws.subs = new Set();
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => {});
  ws.on("message", async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const reply = r => ws.readyState === 1 && ws.send(JSON.stringify({ ...r, t: "reply", id: m.id }));
    if (!allowed(ws.principal, m.t)) return reply({ error: "This device isn't allowed to do that", code: "forbidden" });
    const h = handlers[m.t];
    if (!h) return reply({ error: `unknown message ${m.t}` });
    try { reply(await h(m, ws) || {}); }
    catch (e) { log("handler error", m.t, e?.message); reply({ error: String(e?.message || e), code: e?.code, kind: e?.kind, short: e?.short }); }
  });
}

/** A request body, refused past max bytes (pairing bodies are tiny). */
async function readBody(req, max) {
  let body = "", size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) { const e = new Error("Body too large"); e.code = "too_large"; throw e; }
    body += c;
  }
  return body;
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
      ...running.flatMap(s => { const a = s.activity.snapshot(); return toNative({ type: "activity", sessionId: s.sessionId, title: s.title, phase: a.phase, label: a.label, detail: a.detail, turnStart: a.turnStart, engine: s.engine }); }),
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
