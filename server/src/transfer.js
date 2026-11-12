// Moving things between Pocket Agent servers (e.g. Termux → the app's built-in Linux):
//   - chat import: copy another server's Claude chats (~/.claude/projects) into this one
//   - update channel: pull newer server + UI code from another server, then restart
// Both sides run this same file; the source side serves /export/sessions.tgz, /bundle/info, /bundle.tgz.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CLAUDE_DIR, UI_DIR, log } from "./config.js";

/** Repo / install root: ~/projects/pocket-agent in Termux, /opt/pocket-agent in the app. */
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const BUNDLE_PATHS = ["server/src", "server/bin", "server/devtools", "server/package.json", "server/package-lock.json", "app/assets/ui"];

// ───── helpers ─────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${out.trim().slice(-300)}`)));
  });
}
/** gzip'd tar of paths (relative to cwd) as a stream; missing paths are skipped. */
export function tarStream(cwd, paths) {
  const existing = paths.filter(p => fs.existsSync(path.join(cwd, p)));
  return spawn("tar", ["czf", "-", "-C", cwd, ...existing], { stdio: ["ignore", "pipe", "ignore"] }).stdout;
}
async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${new URL(url).origin} answered ${r.status}${r.status === 401 ? " (wrong token?)" : ""}`);
  await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
}
const withToken = (base, p, token) => `${base.replace(/\/$/, "")}${p}?token=${encodeURIComponent(token || "")}`;
async function tmpDir(name) { const d = path.join(os.tmpdir(), `pa-${name}-${Date.now()}`); await fsp.mkdir(d, { recursive: true }); return d; }
async function walk(dir, base = dir, out = []) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p)); }
  return out;
}

// ───── chat import ─────
/** Reads the folder a chat was started in, from its transcript. */
async function chatCwd(file) {
  const fd = await fsp.open(file, "r");
  const buf = Buffer.alloc(64 * 1024); const { bytesRead } = await fd.read(buf, 0, buf.length, 0); await fd.close();
  for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) { try { const d = JSON.parse(line); if (d.cwd) return d.cwd; } catch {} }
  return null;
}

/** Copies another server's chats into ~/.claude/projects; newer/larger copies win, nothing is deleted. */
export async function importSessions({ url, token }) {
  const tmp = await tmpDir("import");
  try {
    const tgz = path.join(tmp, "sessions.tgz");
    await download(withToken(url, "/export/sessions.tgz", token), tgz);
    await run("tar", ["xzf", tgz, "-C", tmp]);
    const src = path.join(tmp, "projects"), dst = path.join(CLAUDE_DIR, "projects");
    let added = 0, updated = 0, same = 0; const folders = new Set();
    for (const rel of await walk(src)) {
      const a = path.join(src, rel), b = path.join(dst, rel);
      const sa = await fsp.stat(a); let sb = null; try { sb = await fsp.stat(b); } catch {}
      if (!sb) added += rel.endsWith(".jsonl") ? 1 : 0;
      else if (sa.size > sb.size || sa.mtimeMs > sb.mtimeMs + 1000) updated += rel.endsWith(".jsonl") ? 1 : 0;
      else { same++; continue; }
      await fsp.mkdir(path.dirname(b), { recursive: true });
      await fsp.copyFile(a, b);
      await fsp.utimes(b, sa.atime, sa.mtime);
      if (rel.endsWith(".jsonl")) { const cwd = await chatCwd(a); if (cwd) folders.add(cwd); }
    }
    // Recreate each chat's folder (empty) so it can be continued here; its files stay on the other server.
    const made = [];
    for (const f of folders) if (!fs.existsSync(f)) { try { await fsp.mkdir(f, { recursive: true }); made.push(f); } catch {} }
    log("imported chats from", url, { added, updated, same, foldersCreated: made.length });
    return { added, updated, unchanged: same, foldersCreated: made };
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// ───── update channel ─────
/** Content hash of the server + UI code (same file set on every server). */
export async function bundleInfo(root = ROOT) {
  const h = crypto.createHash("sha256");
  const files = [];
  for (const p of BUNDLE_PATHS) {
    const full = path.join(root, p);
    try { if ((await fsp.stat(full)).isDirectory()) for (const f of await walk(full)) files.push(path.join(p, f)); else files.push(p); } catch {}
  }
  for (const f of files.filter(f => !f.includes("node_modules")).sort()) { h.update(f + "\0"); h.update(await fsp.readFile(path.join(root, f))); }
  let version = ""; try { version = JSON.parse(await fsp.readFile(path.join(root, "server/package.json"), "utf8")).version; } catch {}
  return { hash: h.digest("hex").slice(0, 16), version, uiVersion: undefined };
}
export const bundleStream = () => tarStream(ROOT, BUNDLE_PATHS);

/** Source label for messages: a server URL or a local folder. */
export const sourceName = ch => ch.github ? "github.com/" + ch.github : ch.path || ch.url;

// ───── GitHub releases as an update source ─────
// A release (scripts/release.sh) carries: pocket-agent.apk, pocket-agent.json (APK version),
// bundle.tgz (server + UI code) and bundle.json ({ hash }). Private repos need a token.
const GH_API = process.env.PA_GITHUB_API || "https://api.github.com";   // overridable for tests
function ghHeaders(token, accept = "application/vnd.github+json") {
  const h = { Accept: accept, "User-Agent": "pocket-agent", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = "Bearer " + token;
  return h;
}
export async function latestRelease({ github, token }) {
  const r = await fetch(`${GH_API}/repos/${github}/releases/latest`, { headers: ghHeaders(token) });
  if (r.status === 404) throw new Error(token ? `No release in ${github} yet, or the token can't see that repo` : `Can't see ${github}. If it's private, add a GitHub token in Settings.`);
  if (r.status === 401) throw new Error("GitHub rejected the token (expired or mistyped?)");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}
/** Fetch response for a release file (follows GitHub's redirect to its download host). */
export async function releaseAsset(ch, rel, name) {
  const a = (rel.assets || []).find(x => x.name === name);
  if (!a) throw new Error(`Release ${rel.tag_name} has no ${name}`);
  const r = await fetch(a.url, { headers: ghHeaders(ch.token, "application/octet-stream") });
  if (!r.ok) throw new Error(`Downloading ${name} failed (${r.status})`);
  return r;
}

export async function checkUpdate(ch) {
  if (ch.github) {
    const rel = await latestRelease(ch), local = await bundleInfo();
    const remote = { ...(await (await releaseAsset(ch, rel, "bundle.json")).json()), release: rel.tag_name };
    return { available: remote.hash !== local.hash, remote, local };
  }
  if (ch.path) { const remote = await bundleInfo(ch.path), local = await bundleInfo(); return { available: remote.hash !== local.hash, remote, local }; }
  const { url, token } = ch;
  const r = await fetch(withToken(url, "/bundle/info", token));
  if (!r.ok) throw new Error(`${new URL(url).origin} answered ${r.status}${r.status === 401 ? " (wrong token?)" : ""}`);
  const remote = await r.json(), local = await bundleInfo();
  return { available: remote.hash !== local.hash, remote, local };
}

/** Replaces server + UI code with the other server's, installs changed dependencies, then restarts. */
export async function applyUpdate(ch, restart) {
  const { url, token } = ch;
  const tmp = await tmpDir("update");
  try {
    const tgz = path.join(tmp, "bundle.tgz");
    if (ch.path) await new Promise((res, rej) => { const o = fs.createWriteStream(tgz); tarStream(ch.path, BUNDLE_PATHS).pipe(o).on("finish", res).on("error", rej); });
    else if (ch.github) await fsp.writeFile(tgz, Buffer.from(await (await releaseAsset(ch, await latestRelease(ch), "bundle.tgz")).arrayBuffer()));
    else await download(withToken(url, "/bundle.tgz", token), tgz);
    const x = path.join(tmp, "x"); await fsp.mkdir(x);
    await run("tar", ["xzf", tgz, "-C", x]);
    if (!fs.existsSync(path.join(x, "server/src/index.js"))) throw new Error("The update was incomplete");
    const depsOf = dir => ["server/package.json", "server/package-lock.json"].map(f => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } }).join("");
    const depsChanged = depsOf(x) !== depsOf(ROOT);
    for (const p of BUNDLE_PATHS) {
      if (!fs.existsSync(path.join(x, p))) continue;
      await fsp.rm(path.join(ROOT, p), { recursive: true, force: true });
      await fsp.mkdir(path.dirname(path.join(ROOT, p)), { recursive: true });
      await fsp.rename(path.join(x, p), path.join(ROOT, p));
    }
    if (depsChanged) {
      await run("npm", ["install", "--omit=optional", "--no-audit", "--no-fund"], { cwd: path.join(ROOT, "server") });
      // same marker format as the app's installer (Linux.java), so it won't redo this
      await fsp.writeFile(path.join(ROOT, "server/.deps-installed"), depsOf(ROOT)).catch(() => {});
    }
    log("updated from", sourceName(ch), depsChanged ? "(dependencies changed)" : "");
    setTimeout(restart, 600);
    return { updated: true, depsChanged };
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
