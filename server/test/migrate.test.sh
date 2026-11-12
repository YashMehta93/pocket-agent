#!/data/data/com.termux/files/usr/bin/bash
# Tests "Move from Termux" end to end: the running Termux server (source, 8765) → a throwaway
# app-like server (8766) with a fake HOME and a fake Termux path. Never touches the real home.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD; T=$(mktemp -d); trap 'kill $PID 2>/dev/null; chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/fake-termux/home/projects/pocket-agent" "$T/root/server" "$T/root/app/assets"
echo "left by an earlier chat import" > "$T/fake-termux/home/projects/pocket-agent/.import-placeholder"
cp -r server/src server/bin server/package.json "$T/root/server/"; ln -s "$REPO/server/node_modules" "$T/root/server/node_modules"
cp -r app/assets/ui "$T/root/app/assets/"
(HOME="$T/home" PA_SUPERVISED=1 PA_TERMUX_HOME="$T/fake-termux/home" PA_MIGRATE_SKIP_DEPS=1 node "$T/root/server/src/index.js" --port 8766 > "$T/server.log" 2>&1) & PID=$!
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8766/health >/dev/null && break; sleep 0.3; done
SRC_TOKEN=$(cat ~/.pocket-agent/token) TGT_TOKEN=$(cat "$T/home/.pocket-agent/token") T="$T" REPO="$REPO" node --input-type=module -e '
import WebSocket from "'"$REPO"'/server/node_modules/ws/index.js";
import fs from "node:fs";
const T = process.env.T, H = T + "/home";
let fails = 0; const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fails++; };
const ws = new WebSocket("ws://127.0.0.1:8766/ws?token=" + process.env.TGT_TOKEN);
await new Promise(r => ws.on("open", r));
let n = 0; const call = (t, m = {}) => new Promise((res, rej) => { const id = ++n; const h = raw => { const r = JSON.parse(raw); if (r.t === "reply" && r.id === id) { ws.off("message", h); r.error ? rej(new Error(r.error)) : res(r); } }; ws.on("message", h); ws.send(JSON.stringify({ t, id, ...m })); });
const steps = new Set(); let final = null;
ws.on("message", raw => { const m = JSON.parse(raw); if (m.t === "migrate") { steps.add(m.job.step); if (!m.job.running && (m.job.done || m.job.error)) final = m.job; } });
await call("migrate.run", { url: "http://127.0.0.1:8765", token: process.env.SRC_TOKEN });
const t0 = Date.now(); while (!final && Date.now() - t0 < 240000) await new Promise(r => setTimeout(r, 250));
ok(`move finished (${final?.error || "ok"}) in ${Math.round((Date.now() - t0) / 1000)}s`, final?.done);
ok(`went through steps: ${[...steps].join(" → ")}`, ["download", "files", "paths", "tools", "deps", "done"].every(s => steps.has(s)));
const ex = p => { try { fs.lstatSync(H + p); return true; } catch { return false; } };
ok("project moved with its build SDK and signing key", ex("/projects/pocket-agent/build.sh") && ex("/projects/pocket-agent/sdk/android.jar") && ex("/projects/pocket-agent/pocket-agent.keystore"));
ok("reminder app moved", ex("/.cc/reminder-app"));
ok("no node_modules copied (reinstalled instead)", !ex("/projects/pocket-agent/node_modules") && !ex("/projects/pocket-agent/server/node_modules"));
ok("Claude chats, skills, plugins, settings moved", ex("/.claude/projects") && ex("/.claude/skills") && ex("/.claude/plugins") && ex("/.claude/settings.json"));
ok("Claude login NOT copied", !ex("/.claude/.credentials.json"));
const key = p => p.replace(/[^a-zA-Z0-9]/g, "-");
ok("memory copied to the new home key", fs.existsSync(H + "/.claude/projects/" + key(H) + "/memory/MEMORY.md"));
const ft = T + "/fake-termux/home";
ok("old Termux path is now a link to the new home", fs.lstatSync(ft).isSymbolicLink() && fs.realpathSync(ft) === fs.realpathSync(H));
ok("content that was at the old path was kept", fs.existsSync(H + "/projects/pocket-agent/.import-placeholder"));
const chats = (await call("sessions.list")).sessions;
ok(`chats listed (${chats.length}), including this one`, chats.some(s => s.sessionId.startsWith("dd5c2a3b")));
ok("updates now come from the local repo", (await call("hello")).updateChannel === H + "/projects/pocket-agent");
const chk = await call("update.check");
ok("update check against the local repo works", typeof chk.available === "boolean" && chk.remote?.hash);
ok("build tools step reported clearly when the phone is not connected", (final?.summary?.warnings || []).some(w => /Build tools/.test(w)));
// Running the move again after it finished (e.g. "Try again" for a failed step) must work.
final = null; steps.clear();
// Simulate "the app copy is behind Termux": rewind it one commit; the re-run must fast-forward it.
const { execSync } = await import("node:child_process");
const repoDir = H + "/projects/pocket-agent";
execSync(`git -C "${repoDir}" reset --hard -q HEAD~1`);
const srcHead = execSync(`git -C "${process.env.REPO}" rev-parse HEAD`).toString().trim();
let again = null; try { again = (await call("migrate.run", { url: "http://127.0.0.1:8765", token: process.env.SRC_TOKEN })).job; } catch (e) { again = { error: e.message }; }
ok("running the move a second time is allowed (" + (again.error || "started") + ")", !again.error);
const t1 = Date.now(); while (!final && Date.now() - t1 < 240000) await new Promise(r => setTimeout(r, 250));
ok("second run finishes and keeps everything", final?.done && fs.lstatSync(ft).isSymbolicLink() && ex("/projects/pocket-agent/build.sh"));
ok("re-run brought the project up to the Termux version", execSync(`git -C "${repoDir}" rev-parse HEAD`).toString().trim() === srcHead);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
'
