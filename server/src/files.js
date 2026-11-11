// File browsing, search (for @mentions), reading and uploads.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HOME } from "./config.js";

const IGNORE = new Set([".git", "node_modules", ".gradle", "build", "dist", ".cache", "__pycache__", ".venv", "venv", ".next"]);
const MAX_READ = 512 * 1024;

export async function listDir(p) {
  p = path.resolve(p || HOME);
  const entries = [];
  for (const e of await fsp.readdir(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    let st = null; try { st = await fsp.stat(full); } catch {}
    entries.push({ name: e.name, dir: !!st?.isDirectory(), size: st?.size || 0, mtime: st?.mtimeMs || 0 });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { path: p, parent: path.dirname(p), entries };
}

/** Fuzzy-ish path search under cwd, best matches first. */
export async function searchFiles(cwd, q, limit = 40) {
  q = (q || "").toLowerCase();
  const results = [];
  let seen = 0;
  async function walk(dir, depth) {
    if (depth > 8 || seen > 20000 || results.length >= 400) return;
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (IGNORE.has(e.name)) continue;
      seen++;
      const full = path.join(dir, e.name);
      const rel = path.relative(cwd, full);
      if (!q || rel.toLowerCase().includes(q)) results.push({ path: rel, dir: e.isDirectory() });
      if (e.isDirectory() && !e.name.startsWith(".")) await walk(full, depth + 1);
    }
  }
  await walk(cwd, 0);
  const score = r => { const n = path.basename(r.path).toLowerCase(); return (n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2) + r.path.length / 1000; };
  return results.sort((a, b) => score(a) - score(b)).slice(0, limit);
}

export async function readFile(p) {
  const st = await fsp.stat(p);
  const fd = await fsp.open(p, "r");
  const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
  await fd.read(buf, 0, buf.length, 0); await fd.close();
  const binary = buf.includes(0);
  return { path: p, size: st.size, truncated: st.size > MAX_READ, binary, text: binary ? null : buf.toString("utf8") };
}

/** Saves an attachment into <cwd>/.pocket-agent-uploads/ and returns its path. */
export async function saveUpload(cwd, name, base64) {
  const dir = path.join(cwd || HOME, ".pocket-agent-uploads");
  await fsp.mkdir(dir, { recursive: true });
  const safe = path.basename(name || "file").replace(/[^\w.\- ]+/g, "_");
  let p = path.join(dir, safe), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${i++}-${safe}`);
  await fsp.writeFile(p, Buffer.from(base64, "base64"));
  return p;
}
