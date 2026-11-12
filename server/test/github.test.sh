#!/usr/bin/env bash
# Tests updating from GitHub releases (what friends' apps do) against a fake GitHub API that
# behaves like a private repo: no token → 404, right token → the release made by
# `scripts/release.sh --dry-run`. A throwaway "fresh install" server (own HOME, own code copy,
# repo baked into package.json) checks, applies and downloads the APK. No network needed.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; T=$(mktemp -d); PIDS=""
trap 'kill $PIDS 2>/dev/null; [ -n "${SHOWLOG:-}" ] && tail -15 "$T/server.log"; rm -rf "$T"' EXIT
# (re)build the release files when missing or older than the code: the test applies them and runs that code
if [ ! -f build/release/bundle.tgz ] || [ -n "$(find server/src server/devtools app/assets/ui -newer build/release/bundle.tgz | head -1)" ]; then
  bash scripts/release.sh --dry-run >/dev/null
fi

# fake GitHub, token "t0k" required: /repos/me/pa/releases/latest (v9.9.9), /repos/me/pa/releases (a beta,
# v9.9.9, and an old v1.0.0 whose bundle.json has a lower build), /assets/<tag>/<name>
node -e '
const http = require("http"), fs = require("fs"), dir = process.argv[1];
const names = ["pocket-agent.apk", "pocket-agent.json", "bundle.tgz", "bundle.json"];
http.createServer((q, r) => {
  if (q.headers.authorization !== "Bearer t0k") { r.writeHead(404); return r.end("{}"); }
  const rel = (tag, extra = {}) => ({ tag_name: tag, name: "Pocket Agent " + tag, body: "- notes for " + tag, published_at: "2026-11-12T00:00:00Z", draft: false, prerelease: false, ...extra,
    assets: names.map(n => ({ name: n, url: "http://127.0.0.1:8777/assets/" + tag + "/" + n })) });
  const json = v => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(v)); };
  if (q.url === "/repos/me/pa/releases/latest") return json(rel("v9.9.9"));
  if (q.url.startsWith("/repos/me/pa/releases?")) return json([rel("v9.10.0-beta.1", { prerelease: true }), rel("v9.9.9"), rel("v1.0.0"), rel("v0.9.0", { draft: true })]);
  const m = q.url.match(/^\/assets\/([^/]+)\/(.+)$/);
  if (m && names.includes(m[2]) && q.headers.accept === "application/octet-stream") {
    if (m[1] === "v1.0.0" && m[2] === "bundle.json") return json({ hash: "0ld0ld0ld0ld0ld0", version: "1.0.0", build: 1 });
    r.writeHead(200); return r.end(fs.readFileSync(dir + "/" + m[2]));
  }
  r.writeHead(404); r.end();
}).listen(8777);' "$REPO/build/release" & PIDS="$PIDS $!"

mkdir -p "$T/home" "$T/root/server" "$T/root/app/assets"
cp -r server/src server/bin server/devtools server/package-lock.json "$T/root/server/"
node -e 'const p = require(process.argv[1] + "/server/package.json"); p.pocketAgent = { githubRepo: "me/pa" }; require("fs").writeFileSync(process.argv[2], JSON.stringify(p, null, 2))' "$REPO" "$T/root/server/package.json"
ln -s "$REPO/server/node_modules" "$T/root/server/node_modules"
cp -r app/assets/ui "$T/root/app/assets/"; echo "/* older */" >> "$T/root/app/assets/ui/css/app.css"
(env -u PA_MODE HOME="$T/home" PA_DATA="$T/home/.pocket-agent" PA_SUPERVISED=1 PA_GITHUB_API=http://127.0.0.1:8777 node "$T/root/server/src/index.js" --port 8767 > "$T/server.log" 2>&1) & SPID=$!; PIDS="$PIDS $SPID"
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8767/health >/dev/null && break; sleep 0.3; done

TOK=$(cat "$T/home/.pocket-agent/token") T="$T" REPO="$REPO" SPID=$SPID node --input-type=module -e '
import WebSocket from "'"$REPO"'/server/node_modules/ws/index.js";
import fs from "node:fs";
let fails = 0; const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fails++; };
const ws = new WebSocket("ws://127.0.0.1:8767/ws?token=" + process.env.TOK);
await new Promise(r => ws.on("open", r));
let n = 0; const call = (t, m = {}) => new Promise((res, rej) => { const id = ++n; const h = raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === id) { ws.off("message", h); r.error ? rej(new Error(r.error)) : res(r); } }; ws.on("message", h); ws.send(JSON.stringify({ t, id, ...m })); });
const err = async p => { try { await p; return null; } catch (e) { return e.message; } };
const hello = await call("hello");
ok(`fresh install follows the repo in package.json (${hello.updateChannel})`, hello.updateChannel === "github.com/me/pa" && hello.updateKind === "github");
const noTok = await err(call("update.check"));
ok(`private repo without a token says what to do ("${noTok}")`, /add a GitHub token/.test(noTok || ""));
await call("update.channel", { github: "https://github.com/me/pa.git", token: "t0k" });
const h2 = await call("hello");
ok("token saved, repo URL normalised", h2.updateChannel === "github.com/me/pa" && h2.githubToken === true);
const chk = await call("update.check");
ok(`update found in release ${chk.remote?.release}`, chk.available === true);
const app = await call("app.update");
const want = JSON.parse(fs.readFileSync(process.env.REPO + "/build/release/pocket-agent.json", "utf8"));
ok(`APK version from the release (${app.versionName})`, app.versionCode === want.versionCode && app.url === "/apk/download");
const dl = await fetch("http://127.0.0.1:8767/apk/download?token=" + process.env.TOK);
const apk = Buffer.from(await dl.arrayBuffer());
ok(`APK streams through the app server (${apk.length} bytes)`, dl.ok && apk.equals(fs.readFileSync(process.env.REPO + "/build/release/pocket-agent.apk")));
// release tracks: stable follows /latest, beta includes pre-releases, a pinned version may be older
const vers = await call("releases.list");
ok(`versions list: newest first, drafts left out (${vers.releases.map(x => x.tag).join(", ")})`, vers.releases.length === 3 && vers.releases[0].prerelease && vers.track.track === "stable");
await call("update.track", { track: "beta" });
const beta = await call("update.check");
ok(`beta track follows the newest pre-release (${beta.remote?.release})`, beta.remote?.release === "v9.10.0-beta.1" && beta.remote.prerelease === true);
await call("update.track", { track: "pin", tag: "v1.0.0" });
fs.writeFileSync(process.env.T + "/root/applied.json", JSON.stringify({ build: 50 }));   // this app runs build 50
const pin = await call("update.check");
fs.unlinkSync(process.env.T + "/root/applied.json");
ok(`a pinned older version is offered on purpose (build ${pin.remote?.build} < ${pin.local?.build})`, pin.older === true && pin.available === true && pin.remote.release === "v1.0.0");
const h3 = await call("hello");
ok("hello reports the track", h3.updateTrack?.track === "pin" && h3.updateTrack.tag === "v1.0.0");
await call("update.track", { track: "stable" });
// rollback guard: an app that already runs newer code must refuse the (older) release
fs.writeFileSync(process.env.T + "/root/applied.json", JSON.stringify({ build: 999999 }));
const old = await call("update.check");
ok(`older release is not offered (release build ${old.remote?.build} < app build ${old.local?.build})`, old.older === true && old.available === false);
const refused = await err(call("update.apply"));
ok(`applying it is refused ("${(refused || "").slice(0, 60)}…")`, /older code/.test(refused || ""));
fs.unlinkSync(process.env.T + "/root/applied.json");
const ap = await call("update.apply");
ok("update applied", ap.updated === true);
await new Promise(r => setTimeout(r, 2500));
const css = fs.readFileSync(process.env.T + "/root/app/assets/ui/css/app.css", "utf8");
ok("code replaced by the release version", !css.includes("/* older */"));
ok("the applied build is recorded for the next check", JSON.parse(fs.readFileSync(process.env.T + "/root/applied.json", "utf8")).build > 0);
let alive = true; try { process.kill(+process.env.SPID, 0); } catch { alive = false; }
ok("server exited to be restarted by the app", !alive);
// restart it like the app does: the same release must now count as installed (no update offered again)
const { spawn } = await import("node:child_process");
const env = { ...process.env, HOME: process.env.T + "/home", PA_DATA: process.env.T + "/home/.pocket-agent", PA_SUPERVISED: "1", PA_GITHUB_API: "http://127.0.0.1:8777", PA_UPDATE_FIRST_MS: "6000" }; delete env.PA_MODE;
const srvLog = fs.openSync(process.env.T + "/server2.log", "a");
const srv = spawn("node", [process.env.T + "/root/server/src/index.js", "--port", "8767"], { env, stdio: ["ignore", srvLog, srvLog] });
for (let i = 0; i < 40; i++) { try { if ((await fetch("http://127.0.0.1:8767/health")).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
const ws2 = new WebSocket("ws://127.0.0.1:8767/ws?token=" + process.env.TOK); await new Promise(r => ws2.on("open", r));
const again = await new Promise(res => { ws2.on("message", raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === 1) res(r); }); ws2.send(JSON.stringify({ t: "update.check", id: 1 })); });
ok(`after restarting, the release counts as installed (local ${again.local?.hash} = release ${again.remote?.hash})`, again.available === false && again.local?.hash === again.remote?.hash);
// the background check tells the phone once per release (this install has no APK info, so the APK of the release counts as newer)
const notes = [];
const http = (await import("node:http")).default;
await new Promise(done => {
  const req = http.get(`http://127.0.0.1:8767/events?v=2&api=4&token=${process.env.TOK}`, res => {
    let buf = "";
    res.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find(l => l.startsWith("data:")); if (!line) continue;
      const ev = JSON.parse(line.slice(5));
      if (ev.type === "rpc") {
        if (ev.method === "notify") notes.push(ev.params);
        const p = http.request(`http://127.0.0.1:8767/native/result?token=${process.env.TOK}`, { method: "POST", headers: { "content-type": "application/json" } });
        p.end(JSON.stringify({ id: ev.id, result: true }));
      } } });
  });
  setTimeout(() => { req.destroy(); done(); }, 12000);
});
const upd = notes.filter(n => n.id === "update");
ok(`a new release posts one notification (${upd.map(n => n.title).join("; ")})`, upd.length === 1 && /9\.9\.9 is available/.test(upd[0].title) && upd[0].onlyWhenBackground);
if (upd.length !== 1) console.log(fs.readFileSync(process.env.T + "/server2.log", "utf8").split("\n").slice(-8).join("\n"));
ok("and remembers it, so it is not repeated", JSON.parse(fs.readFileSync(process.env.T + "/home/.pocket-agent/prefs.json", "utf8")).notifiedRelease === "v9.9.9");
ws2.close(); srv.kill();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
'
