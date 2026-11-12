// Tests backups, the folder update source, Termux setup routes, personal branches and open-pr.sh.
// Everything runs in a throwaway HOME / PA_DATA with fake GitHub; no network, no Claude, and the app's
// real data is never touched.   node server/test/extras.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execSync, spawn } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-extras-"));
const HOME = path.join(T, "home");
Object.assign(process.env, { HOME, PA_DATA: path.join(HOME, ".pocket-agent"), PA_BACKUP_DIR: path.join(T, "sdcard/Pocket Agent"), PA_PORT: "8769" });
delete process.env.PA_MODE; delete process.env.PA_SUPERVISED;
fs.mkdirSync(process.env.PA_DATA, { recursive: true });

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).toString();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

try {
  // ───── backups ─────
  const { createBackup, listBackups, restoreBackup } = await import("../src/backup.js");
  write(path.join(HOME, ".claude/projects/-root/chat1.jsonl"), "{\"hello\":1}\n");
  write(path.join(HOME, ".claude/projects/-root/memory/MEMORY.md"), "- memory\n");
  write(path.join(HOME, ".claude/.credentials.json"), "{\"secret\":true}");
  write(path.join(HOME, ".claude/settings.json"), "{}");
  write(path.join(HOME, "projects/app/main.js"), "console.log(1)\n");
  write(path.join(HOME, "projects/app/pocket-agent.keystore"), "key");
  write(path.join(HOME, "projects/app/node_modules/big/index.js"), "x");
  write(path.join(HOME, ".config/pocket-agent/github-token"), "ghp_secret");
  write(path.join(process.env.PA_DATA, "prefs.json"), "{\"pinned\":[]}");
  // what real homes have: hard links (proot fakes them with .l2s.* symlinks) and broken leftovers in .git
  write(path.join(HOME, "projects/app/.git/objects/pack/pack-1.pack"), "PACK");
  fs.linkSync(path.join(HOME, "projects/app/.git/objects/pack/pack-1.pack"), path.join(HOME, "projects/app/.git/objects/pack/pack-1.keep"));
  fs.symlinkSync("loop", path.join(HOME, "projects/app/.git/objects/pack/loop"));
  const b = await createBackup();
  const names = sh(`tar tzf '${b.file}'`).split("\n");
  ok("backup written to phone storage", fs.existsSync(b.file) && b.bytes > 0, b.file.replace(T, ""));
  ok("backup has chats, memory, projects, keystore, prefs", [".claude/projects/-root/chat1.jsonl", ".claude/projects/-root/memory/MEMORY.md", "projects/app/main.js", "projects/app/pocket-agent.keystore", ".pocket-agent/prefs.json"].every(n => names.includes(n)));
  ok("backup has no sign-in, tokens or node_modules", !names.some(n => /credentials|github-token|node_modules/.test(n)));
  ok("backup is listed", (await listBackups()).some(x => x.file === b.file));
  fs.rmSync(path.join(HOME, ".claude/projects"), { recursive: true });
  await restoreBackup(b.file);
  ok("restore brings chats back", fs.readFileSync(path.join(HOME, ".claude/projects/-root/chat1.jsonl"), "utf8").includes("hello"));
  ok("hard-linked files are backed up by content", names.includes("projects/app/.git/objects/pack/pack-1.keep") && !names.some(n => n.includes(".l2s.")));
  const evil = path.join(process.env.PA_BACKUP_DIR, "pocket-agent-backup-evil.tgz");
  write(path.join(T, "evil/x"), "x"); sh(`tar czf '${evil}' -C '${T}/evil' --transform 's,^,../,' x`);
  let refused = null; try { await restoreBackup(evil); } catch (e) { refused = e.message; }
  ok("restore refuses paths outside home", /unsafe/.test(refused || ""), refused || "");
  refused = null; try { await restoreBackup("/etc/passwd"); } catch (e) { refused = e.message; }
  ok("restore refuses files that aren't backups", !!refused);

  // ───── folder update source offers the last commit ─────
  const { checkUpdate } = await import("../src/transfer.js");
  const src = path.join(T, "src");
  sh(`git clone -q --no-hardlinks '${REPO}' '${src}'`);
  sh(`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base`, src);
  const c1 = await checkUpdate({ path: src });
  write(path.join(src, "server/src/wip.js"), "// half-finished\n");
  const c2 = await checkUpdate({ path: src });
  ok("uncommitted edits aren't offered", c2.remote.hash === c1.remote.hash);
  sh(`git add -A && git -c user.email=t@t -c user.name=t commit -q -m wip`, src);
  const c3 = await checkUpdate({ path: src });
  ok("a commit is offered", c3.remote.hash !== c1.remote.hash && c3.remote.build === c1.remote.build + 1, `build ${c1.remote.build} → ${c3.remote.build}`);

  // ───── personal branch ─────
  const { personalBranch, phoneContext } = await import("../src/devtools.js");
  const origin = path.join(T, "origin.git");
  sh(`git init -q --bare '${origin}'`);
  const seed = path.join(T, "seed");
  // (fetching into the bare repo: pushing to a local repo fails inside proot, in git's quarantine step)
  sh(`git init -q '${seed}' && cd '${seed}' && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m one && git branch -M master`);
  sh(`git -C '${origin}' fetch -q '${seed}' master:master`);
  for (const br of ["v2.x", "v10.x", "me/alice"]) { sh(`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m ${br.replace("/", "-")}`, seed); sh(`git -C '${origin}' fetch -q '${seed}' HEAD:refs/heads/${br}`); }
  const clone = path.join(T, "clone"); sh(`git clone -q '${origin}' '${clone}'`);
  const bob = await personalBranch(clone, { login: "Bob", id: 7, name: "Bob B" });
  ok("new person gets me/<login> from the newest vN.x", bob === "me/bob" && sh(`git rev-parse HEAD`, clone) === sh(`git rev-parse origin/v10.x`, clone), sh("git branch --show-current", clone).trim());
  ok("commits use the GitHub noreply address", sh("git config user.email", clone).trim() === "7+Bob@users.noreply.github.com");
  ok("the branch owner is recorded for the push hook", sh("git config pocketagent.me", clone).trim() === "bob");
  await personalBranch(clone, { login: "alice", id: 8 });
  ok("returning person gets their existing branch", sh("git branch --show-current", clone).trim() === "me/alice" && sh("git rev-parse HEAD", clone) === sh("git rev-parse origin/me/alice", clone));
  ok("Claude is told about the termux command", /`termux <command>`/.test(phoneContext()));
  const { githubRepo } = await import("../src/config.js");
  ok("any way of writing a GitHub repo becomes owner/repo", ["me/pa", "github.com/me/pa", "https://github.com/me/pa.git", "https://www.github.com/me/pa/", "git@github.com:me/pa.git", " me/pa.git "].every(x => githubRepo(x) === "me/pa"));

  // ───── open-pr.sh against a fake GitHub ─────
  let got = null;
  const gh = http.createServer((q, r) => { let body = ""; q.on("data", d => body += d).on("end", () => {
    got = { url: q.url, auth: q.headers.authorization, body: JSON.parse(body || "{}") };
    r.writeHead(201, { "content-type": "application/json" }); r.end(JSON.stringify({ html_url: "https://github.com/me/pa/pull/1" }));
  }); }).listen(8778);
  sh(`git remote set-url origin https://github.com/me/pa.git && git config url.'${origin}'.insteadOf https://github.com/me/pa.git && git switch -q -c feat/thing && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'Add thing'`, clone);
  fs.mkdirSync(path.join(clone, "scripts"), { recursive: true }); fs.copyFileSync(path.join(REPO, "scripts/open-pr.sh"), path.join(clone, "scripts/open-pr.sh"));
  const out = await new Promise(res => { const p = spawn("bash", ["scripts/open-pr.sh", "Add a thing"], { cwd: clone, env: { ...process.env, GITHUB_TOKEN: "t0k", PA_GITHUB_API: "http://127.0.0.1:8778" } }); let o = ""; p.stdout.on("data", d => o += d); p.stderr.on("data", d => o += d); p.on("close", () => res(o)); });
  gh.close();
  ok("open-pr.sh opens a PR into the newest vN.x", got?.url === "/repos/me/pa/pulls" && got.body.base === "v10.x" && got.body.head === "feat/thing" && got.auth === "Bearer t0k" && /pull\/1/.test(out), out.trim().split("\n").pop());

  // ───── Termux setup routes ─────
  const server = spawn("node", [path.join(REPO, "server/src/index.js"), "--port", "8769"], { env: process.env, stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch("http://127.0.0.1:8769/health")).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const bad = await fetch("http://127.0.0.1:8769/termux/install.sh?code=nope");
    ok("an unknown code is refused", bad.status === 403);
    const { default: WebSocket } = await import(path.join(REPO, "server/node_modules/ws/index.js"));
    const token = fs.readFileSync(path.join(process.env.PA_DATA, "token"), "utf8").trim();
    const ws = new WebSocket(`ws://127.0.0.1:8769/ws?token=${token}`); await new Promise(r => ws.on("open", r));
    const cmd = await new Promise(res => { ws.on("message", raw => { const m = JSON.parse(raw); if (m.t === "reply" && m.id === 1) res(m.command); }); ws.send(JSON.stringify({ t: "termux.installCommand", id: 1 })); });
    ws.close();
    const url = cmd.match(/'(http[^']+)'/)[1], code = new URL(url).searchParams.get("code");
    ok("install command is a one-liner with a code, not the token", /^curl -fsSL '.+' \| bash$/.test(cmd) && !cmd.includes(token));
    const script = await (await fetch(url)).text();
    ok("installer script has this server and the code filled in", script.includes(`APP="\${PA_APP:-http://127.0.0.1:8769}"`) && script.includes(code));
    fs.writeFileSync(path.join(T, "install.sh"), script);
    ok("installer script is valid bash", (() => { try { sh(`bash -n '${T}/install.sh'`); return true; } catch { return false; } })());
    const tgz = Buffer.from(await (await fetch(`http://127.0.0.1:8769/termux/bundle.tgz?code=${code}`)).arrayBuffer());
    fs.writeFileSync(path.join(T, "b.tgz"), tgz);
    const list = sh(`tar tzf '${T}/b.tgz'`);
    ok("the code downloads the server bundle", list.includes("server/src/index.js") && list.includes("app/assets/ui/index.html"));
  } finally { server.kill(); }
} catch (e) { console.log("FAIL", e.stack); fails++; }
finally { fs.rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
