// "Move from Termux": brings a Termux setup into the app's built-in Linux in one go.
//
// Source side (Termux server): GET /export/migration.tgz streams the home folder minus caches,
// Termux's own Claude install and secrets, plus the Java build tools (d8, apksigner) and `cs`.
// Target side (the app's built-in server): runMigration() downloads it, merges it into /root,
// installs Java + Android build tools (via the app, which can run apk as root), maps old Termux
// paths onto /root so imported chats find their files, and points updates at the local repo.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, CLAUDE_DIR, prefs, savePrefs, log } from "./config.js";
import { broadcastAll, callNative } from "./hub.js";

// Where Termux kept the home folder. Inside the app this path becomes a link to /root.
// Tests override it with a throwaway folder (PA_TERMUX_HOME): the move must never touch a real Termux home.
const TERMUX_HOME = process.env.PA_TERMUX_HOME || "/data/data/com.termux/files/home";
const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
/** Claude names project folders after the path a chat ran in; Termux chats used this one (never overridden). */
const TERMUX_CHATS_PATH = "/data/data/com.termux/files/home";

// ───── source side ─────
const SKIP_TOP = new Set([".npm", ".cache", ".local", "storage", ".termux", ".pocket-agent", ".claude.json", ".gradle"]);
const EXCLUDES = ["node_modules", ".cc/package", ".cc/*.tgz", "projects/*/build", ".claude/sessions", ".claude/shell-snapshots",
  ".claude/daemon*", ".claude/jobs", ".claude/tasks", ".claude/session-env", ".claude/backups", ".claude/cache",
  ".claude/paste-cache", ".claude/.credentials.json", ".claude/plugins/cache"];

export async function migrationEntries() {
  const names = (await fsp.readdir(HOME)).filter(n => !SKIP_TOP.has(n) && !n.startsWith("pa-"));
  return names;
}
/** tar.gz stream of the home folder (minus EXCLUDES) + build tools under pa-tools/. */
export async function migrationStream() {
  const args = ["czf", "-", ...EXCLUDES.map(e => "--exclude=" + e), "-C", HOME, ...(await migrationEntries())];
  const prefix = process.env.PREFIX || TERMUX_PREFIX;
  const extra = [["share/java", "d8.jar"], ["share/java", "apksigner.jar"], ["bin", "cs"]].filter(([d, f]) => fs.existsSync(path.join(prefix, d, f)));
  for (const [d, f] of extra) args.push("--transform", `s,^${f.replace(".", "\\.")}$,pa-tools/${f},`, "-C", path.join(prefix, d), f);
  return spawn("tar", args, { stdio: ["ignore", "pipe", "ignore"] }).stdout;
}

// ───── target side ─────
let job = { running: false, step: null, lines: [], error: null, done: false, summary: null };
export const migrationStatus = () => job;
function emit(patch) { Object.assign(job, patch); broadcastAll({ t: "migrate", job: { ...job, lines: job.lines.slice(-200) } }); }
function line(s) { for (const l of String(s).split("\n")) if (l.trim()) job.lines.push(l.slice(0, 400)); if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400); emit({}); }

function sh(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    const on = d => { out += d; if (opts.stream !== false) line(d.toString()); };
    p.stdout.on("data", on); p.stderr.on("data", on);
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.trim().split("\n").slice(-3).join(" | ")}`)));
  });
}
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
/** Copies without overwriting anything that's already here (Node, not cp flags: Alpine's BusyBox cp differs). */
const copyMissing = (src, dst) => fsp.cp(src, dst, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true, verbatimSymlinks: true });
/** Copies, replacing files only when the incoming one is newer or larger (chat transcripts grow). */
const copyNewer = (src, dst) => fsp.cp(src, dst, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true,
  filter: async (a, b) => { const sa = await fsp.lstat(a); if (sa.isDirectory()) return true; try { const sb = await fsp.lstat(b); return sa.size > sb.size || sa.mtimeMs > sb.mtimeMs + 1000; } catch { return true; } } });
async function findGitRepos(root, depth = 3) {
  const out = [];
  async function walk(d, n) {
    if (n > depth) return;
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === ".git")) { out.push(d); return; }
    for (const e of ents) if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".claude")) await walk(path.join(d, e.name), n + 1);
  }
  await walk(root, 0);
  return out;
}
async function findPackages(dirs, depth = 3) {
  const out = [];
  async function walk(d, n) {
    if (n > depth) return;
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === "package.json" && e.isFile())) out.push(d);
    for (const e of ents) if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".git")) await walk(path.join(d, e.name), n + 1);
  }
  for (const d of dirs) await walk(d, 0);
  return out;
}

export function runMigration({ url, token }) {
  if (job.running) throw new Error("A move is already running");
  // Safety: only inside the app (supervised), and never when this *is* the Termux home.
  if (!process.env.PA_SUPERVISED) throw new Error("Moving from Termux runs inside the Pocket Agent app (built-in mode), not on this server.");
  // The old Termux path being a *link* to this home is fine: that is what a previous move created.
  const termuxIsLink = exists(TERMUX_HOME) && fs.lstatSync(TERMUX_HOME).isSymbolicLink();
  if (path.resolve(HOME) === path.resolve(TERMUX_HOME) || (!termuxIsLink && exists(TERMUX_HOME) && fs.realpathSync(HOME) === fs.realpathSync(TERMUX_HOME)))
    throw new Error("Refusing to move: this server already runs in the Termux home.");
  job = { running: true, step: "download", lines: [], error: null, done: false, summary: null };
  migrate(url.replace(/\/$/, ""), token).then(summary => emit({ running: false, done: true, step: "done", summary }))
    .catch(e => { log("migration failed", e.message); line("ERROR: " + e.message); emit({ running: false, error: e.message }); });
  return job;
}

async function migrate(url, token) {
  const work = path.join(HOME, ".pa-migration");
  await fsp.rm(work, { recursive: true, force: true }); await fsp.mkdir(path.join(work, "x"), { recursive: true });
  const summary = { files: false, tools: false, warnings: [] };

  // 1. download
  emit({ step: "download" }); line(`Downloading from ${url} …`);
  const r = await fetch(`${url}/export/migration.tgz?token=${encodeURIComponent(token || "")}`);
  if (!r.ok) throw new Error(`${url} answered ${r.status}${r.status === 401 ? " (wrong token?)" : r.status === 404 ? " (update the Termux server: pocket-agent restart)" : ""}`);
  const tgz = path.join(work, "migration.tgz");
  const out = fs.createWriteStream(tgz); let got = 0, last = 0;
  for await (const chunk of r.body) { out.write(chunk); got += chunk.length; if (got - last > 5e6) { last = got; line(`  ${Math.round(got / 1e6)} MB`); } }
  await new Promise(res => out.end(res));
  line(`Downloaded ${Math.round(got / 1e6)} MB`);

  // 2. unpack + merge into home (never overwrites what's already here)
  emit({ step: "files" }); line("Unpacking and copying your files…");
  const x = path.join(work, "x");
  await sh(`tar xzf "${tgz}" -C "${x}"`, { stream: false });
  for (const name of await fsp.readdir(x)) {
    if (name === "pa-tools" || name === ".claude") continue;
    line(`  ${name}`);
    await copyMissing(path.join(x, name), path.join(HOME, name));
  }
  // Re-runs: bring git projects that were moved before up to date (fast-forward only, never over local work).
  for (const repo of await findGitRepos(x)) {
    const rel = path.relative(x, repo), dest = path.join(HOME, rel);
    if (!exists(path.join(dest, ".git"))) continue;
    try {
      const dirty = (await sh(`git -C "${dest}" status --porcelain --untracked-files=no`, { stream: false })).trim();
      if (dirty) { summary.warnings.push(`~/${rel} has uncommitted changes here, so it wasn't updated from Termux`); continue; }
      const before = (await sh(`git -C "${dest}" rev-parse HEAD`, { stream: false })).trim();
      await sh(`git -C "${dest}" -c safe.directory='*' pull --ff-only --quiet "${repo}" HEAD`, { stream: false });
      const after = (await sh(`git -C "${dest}" rev-parse HEAD`, { stream: false })).trim();
      if (before !== after) line(`  updated ~/${rel} to the Termux version`);
    } catch (e) { summary.warnings.push(`~/${rel}: couldn't update from Termux (${e.message.slice(0, 120)})`); }
  }
  if (exists(path.join(HOME, ".ssh"))) await sh(`chmod 700 "${HOME}/.ssh" && chmod 600 "${HOME}"/.ssh/* 2>/dev/null; true`, { stream: false });
  // Claude data: chats merge newest-wins (same rules as chat import); config fills in what's missing here
  const xc = path.join(x, ".claude");
  if (exists(xc)) {
    line("  Claude chats, memory, skills, plugins, settings");
    await fsp.mkdir(CLAUDE_DIR, { recursive: true });
    if (exists(path.join(xc, "projects"))) await copyNewer(path.join(xc, "projects"), path.join(CLAUDE_DIR, "projects"));
    await copyMissing(xc, CLAUDE_DIR);
    try {
      const mine = path.join(CLAUDE_DIR, "settings.json"), theirs = JSON.parse(await fsp.readFile(path.join(xc, "settings.json"), "utf8"));
      const cur = exists(mine) ? JSON.parse(await fsp.readFile(mine, "utf8")) : {};
      await fsp.writeFile(mine, JSON.stringify({ ...theirs, ...cur, env: { ...(theirs.env || {}), ...(cur.env || {}) } }, null, 2));
    } catch {}
    // memory is keyed by project folder: Termux home → /root
    const key = p => p.replace(/[^a-zA-Z0-9]/g, "-");
    const oldMem = path.join(CLAUDE_DIR, "projects", key(TERMUX_CHATS_PATH), "memory"), newMem = path.join(CLAUDE_DIR, "projects", key(HOME), "memory");
    if (exists(oldMem)) { await copyNewer(oldMem, newMem); line("  memory → " + newMem.replace(HOME, "~")); }
  }
  summary.files = true;

  // 3. old Termux paths → /root, so imported chats and scripts find their files
  emit({ step: "paths" }); line("Mapping Termux paths to your home folder…");
  if (exists(TERMUX_HOME) && !fs.lstatSync(TERMUX_HOME).isSymbolicLink()) {
    await copyMissing(TERMUX_HOME, HOME).catch(() => {});
    await fsp.rm(TERMUX_HOME, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(TERMUX_HOME), { recursive: true });
  if (!exists(TERMUX_HOME)) await fsp.symlink(HOME, TERMUX_HOME);
  if (exists("/sdcard/Download")) {
    await fsp.mkdir(path.join(HOME, "storage"), { recursive: true });
    for (const [n, t] of [["downloads", "/sdcard/Download"], ["shared", "/sdcard"], ["pictures", "/sdcard/Pictures"], ["dcim", "/sdcard/DCIM"]])
      if (!exists(path.join(HOME, "storage", n)) && exists(t)) await fsp.symlink(t, path.join(HOME, "storage", n));
    line("  ~/storage → phone storage");
  } else summary.warnings.push("Phone storage isn't visible yet: allow Pocket Agent's storage permission, then restart it (Settings → Restart).");

  // 4. build tools (Java, aapt2/zipalign from Alpine, d8/apksigner jars from Termux)
  emit({ step: "tools" }); line("Installing Java and Android build tools (a few minutes)…");
  try {
    const caps = await callNative("capabilities", {}, 10000);
    if ((caps.api || 0) < 3) throw new Error("Update the Pocket Agent app first (it needs version 0.2.14 or newer for this step)");
    const repo = "https://dl-cdn.alpinelinux.org/alpine/edge";
    // Java 17: Alpine's JDK 21 dies at start-up in Android's app sandbox ("Failed to mark memory page
    // as executable"); JDK 17 runs. Remove 21 if an earlier move installed it, and make 17 the default.
    const cmd = `J21=$(apk info 2>/dev/null | grep '^openjdk21' | tr '\\n' ' '); [ -z "$J21" ] || apk del --no-cache $J21; `
      + `apk add --no-cache openjdk17-jdk zip unzip file && ln -sfn java-17-openjdk /usr/lib/jvm/default-jvm && (grep -q '@testing' /etc/apk/repositories || echo '@testing ${repo}/testing' >> /etc/apk/repositories) && `
      + `(apk add --no-cache android-build-tools@testing || apk add --no-cache -X ${repo}/testing -X ${repo}/main -X ${repo}/community android-build-tools)`;
    const res = await callNative("runtime.exec", { cmd, root: true, timeoutMs: 30 * 60_000 }, 31 * 60_000);
    line(res.output.split("\n").slice(-12).join("\n"));
    if (res.code !== 0) throw new Error("apk exit " + res.code);
    await fsp.mkdir("/usr/local/share/java", { recursive: true });
    for (const j of ["d8.jar", "apksigner.jar"]) if (exists(path.join(x, "pa-tools", j))) await fsp.copyFile(path.join(x, "pa-tools", j), path.join("/usr/local/share/java", j));
    await fsp.writeFile("/usr/local/bin/d8", "#!/bin/sh\nexec java -cp /usr/local/share/java/d8.jar com.android.tools.r8.D8 \"$@\"\n", { mode: 0o755 });
    await fsp.writeFile("/usr/local/bin/apksigner", "#!/bin/sh\nexec java -jar /usr/local/share/java/apksigner.jar \"$@\"\n", { mode: 0o755 });
    if (exists(path.join(x, "pa-tools", "cs"))) {
      const cs = (await fsp.readFile(path.join(x, "pa-tools", "cs"), "utf8")).replace(/^#!.*\n/, "#!/usr/bin/env node\n");
      await fsp.writeFile("/usr/local/bin/cs", cs, { mode: 0o755 });
    }
    const v = await sh(`javac -version 2>&1; aapt2 version 2>&1 | head -1; d8 --version 2>&1 | head -1; apksigner --version 2>&1`, { stream: false });
    line(v); summary.tools = true;
  } catch (e) { summary.warnings.push("Build tools: " + e.message); line("Build tools not installed: " + e.message); }

  // 5. project dependencies
  emit({ step: "deps" }); line("Installing project dependencies…");
  if (process.env.PA_MIGRATE_SKIP_DEPS) line("  (skipped for this test)");
  else
  for (const dir of await findPackages([path.join(HOME, "projects"), path.join(HOME, ".cc")])) {
    if (exists(path.join(dir, "node_modules"))) continue;
    line(`  npm install in ${dir.replace(HOME, "~")}`);
    try { await sh(`cd "${dir}" && npm install --no-audit --no-fund --omit=optional 2>&1 | tail -2`); }
    catch (e) { summary.warnings.push(`npm install in ${dir.replace(HOME, "~")}: ${e.message}`); }
  }

  // 6. updates come from the local repo from now on
  const repo = path.join(HOME, "projects/pocket-agent");
  if (exists(path.join(repo, "server/src/index.js"))) {
    prefs.updateChannel = { path: repo }; savePrefs();
    line("Updates now come from ~/projects/pocket-agent");
  }
  await fsp.rm(work, { recursive: true, force: true });
  log("migration finished", JSON.stringify(summary));
  return summary;
}
