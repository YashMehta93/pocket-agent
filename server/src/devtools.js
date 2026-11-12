// Developer tooling inside the app's built-in Linux, with nothing from Termux:
//   installBuildTools()  Java 17, aapt2/zipalign (Alpine), d8 (Google Maven r8), apksigner (our apksig CLI)
//   runDevSetup()        "Build Pocket Agent yourself": tools + clone the repo + android.jar + npm deps,
//                        then point updates at the local copy
//   ensureDefaults()     first-start defaults every install gets (cs, session retention, keybindings)
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, CLAUDE_DIR, prefs, savePrefs, log } from "./config.js";
import { broadcastAll, callNative } from "./hub.js";
import { ROOT } from "./transfer.js";

const MAVEN = "https://dl.google.com/android/maven2";
const R8 = "9.5.29", APKSIG = "9.5.1";                       // newest stable on Google Maven, Nov 2026
const ANDROID_PLATFORM = "https://dl.google.com/android/repository/platform-34-ext7_r03.zip";
const JAVA_DIR = "/usr/local/share/java";
const ALPINE_EDGE = "https://dl-cdn.alpinelinux.org/alpine/edge";

const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
export function sh(cmd, onLine, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("/bin/sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    const on = d => { out += d; if (onLine) for (const l of d.toString().split("\n")) if (l.trim()) onLine(l); };
    p.stdout.on("data", on); p.stderr.on("data", on);
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.trim().split("\n").slice(-3).join(" | ")}`)));
  });
}
async function download(url, file, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
}

/** Installs the APK build toolchain. Package installs need root, which only the app's native side has. */
export async function installBuildTools(line) {
  const caps = await callNative("capabilities", {}, 10000).catch(() => { throw new Error("The Pocket Agent app isn't connected"); });
  if ((caps.api || 0) < 3) throw new Error("Update the Pocket Agent app first (version 0.2.14 or newer)");
  line("Installing Java 17, aapt2 and zipalign (a few minutes)…");
  // Java 17: Alpine's JDK 21 dies at start-up in Android's app sandbox ("Failed to mark memory page as executable").
  const cmd = `J21=$(apk info 2>/dev/null | grep '^openjdk21' | tr '\\n' ' '); [ -z "$J21" ] || apk del --no-cache $J21; `
    + `apk add --no-cache openjdk17-jdk zip unzip file patchelf && ln -sfn java-17-openjdk /usr/lib/jvm/default-jvm && `
    + `(grep -q '@testing' /etc/apk/repositories || echo '@testing ${ALPINE_EDGE}/testing' >> /etc/apk/repositories) && `
    + `(apk add --no-cache android-build-tools@testing || apk add --no-cache -X ${ALPINE_EDGE}/testing -X ${ALPINE_EDGE}/main -X ${ALPINE_EDGE}/community android-build-tools)`;
  const res = await callNative("runtime.exec", { cmd, root: true, timeoutMs: 30 * 60_000 }, 31 * 60_000);
  for (const l of res.output.split("\n").slice(-8)) if (l.trim()) line("  " + l);
  if (res.code !== 0) throw new Error("installing packages failed (apk exit " + res.code + ")");

  line("Downloading d8 and apksig from Google Maven…");
  await fsp.mkdir(JAVA_DIR, { recursive: true });
  await download(`${MAVEN}/com/android/tools/r8/${R8}/r8-${R8}.jar`, path.join(JAVA_DIR, "r8.jar"));
  await download(`${MAVEN}/com/android/tools/build/apksig/${APKSIG}/apksig-${APKSIG}.jar`, path.join(JAVA_DIR, "apksig.jar"));
  line("Building apksigner…");
  const src = path.join(ROOT, "server/devtools/ApkSignerCli.java"), cls = path.join(JAVA_DIR, "apksigner-classes");
  await fsp.rm(cls, { recursive: true, force: true });
  await sh(`javac -nowarn -cp "${JAVA_DIR}/apksig.jar" -d "${cls}" "${src}"`);
  await fsp.writeFile("/usr/local/bin/d8", `#!/bin/sh\nexec java -cp ${JAVA_DIR}/r8.jar com.android.tools.r8.D8 "$@"\n`, { mode: 0o755 });
  await fsp.writeFile("/usr/local/bin/apksigner", `#!/bin/sh\nexec java -cp ${cls}:${JAVA_DIR}/apksig.jar ApkSignerCli "$@"\n`, { mode: 0o755 });
  const v = await sh(`javac -version 2>&1; aapt2 version 2>&1 | head -1; zipalign 2>&1 | head -1; d8 --version 2>&1 | head -1; apksigner --version`);
  for (const l of v.split("\n")) if (l.trim()) line("  " + l);
}

// ───── "Build Pocket Agent yourself" ─────
let job = { running: false, step: null, lines: [], error: null, done: false, summary: null };
export const devSetupStatus = () => job;
function emit(patch) { Object.assign(job, patch); broadcastAll({ t: "devsetup", job: { ...job, lines: job.lines.slice(-200) } }); }
function line(s) { job.lines.push(String(s).slice(0, 400)); if (job.lines.length > 400) job.lines.splice(0, 100); emit({}); }

/** repo: https URL or owner/name; token: GitHub token for private repos. */
export function runDevSetup({ repo, token }) {
  if (job.running) throw new Error("Setup is already running");
  if (!process.env.PA_SUPERVISED) throw new Error("Developer setup runs inside the Pocket Agent app's built-in Linux");
  job = { running: true, step: "tools", lines: [], error: null, done: false, summary: null };
  devSetup(repo, token).then(summary => emit({ running: false, done: true, step: "done", summary }))
    .catch(e => { line("ERROR: " + e.message); emit({ running: false, error: e.message }); });
  return job;
}

async function devSetup(repo, token) {
  const url = /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo.replace(/^\/|\.git$/g, "")}.git`;
  const dest = path.join(HOME, "projects", path.basename(url, ".git"));
  emit({ step: "tools" }); await installBuildTools(line);

  emit({ step: "code" });
  const auth = token ? `-c http.extraHeader="Authorization: Basic ${Buffer.from("x-access-token:" + token).toString("base64")}"` : "";
  if (exists(path.join(dest, ".git"))) { line(`Updating ${dest.replace(HOME, "~")}…`); await sh(`git -C "${dest}" ${auth} pull --ff-only`, line); }
  else { line(`Cloning ${url}…`); await fsp.mkdir(path.dirname(dest), { recursive: true }); await sh(`git ${auth} clone "${url}" "${dest}"`, line); }
  await sh(`git -C "${dest}" config core.hooksPath .githooks`);   // branch rules, docs/RELEASES.md

  emit({ step: "sdk" });
  if (!exists(path.join(dest, "sdk/android.jar"))) {
    line("Downloading the Android 14 platform (android.jar)…");
    const zip = path.join(HOME, ".cache/platform-34.zip"); await fsp.mkdir(path.dirname(zip), { recursive: true });
    await download(ANDROID_PLATFORM, zip);
    await fsp.mkdir(path.join(dest, "sdk"), { recursive: true });
    await sh(`unzip -o -j "${zip}" '*/android.jar' -d "${dest}/sdk" >/dev/null && rm -f "${zip}"`);
  }

  emit({ step: "deps" });
  for (const d of [dest, path.join(dest, "server")]) if (exists(path.join(d, "package.json"))) {
    line(`npm install in ${d.replace(HOME, "~")}…`);
    await sh(`cd "${d}" && npm install --no-audit --no-fund --omit=optional 2>&1 | tail -2`, line);
  }

  emit({ step: "build" });
  line("Test build…");
  await sh(`cd "${dest}" && bash build.sh 2>&1 | tail -3`, line);
  prefs.updateChannel = { path: dest }; savePrefs();
  line(`Updates now come from ${dest.replace(HOME, "~")}`);
  log("dev setup finished", dest);
  return { path: dest };
}

// ───── defaults every install gets ─────
/** What the original setup had, for everyone: `cs`, sessions kept for years, agents-view arrow keys. */
export async function ensureDefaults() {
  try {
    const cs = path.join(ROOT, "server/devtools/cs");
    const writable = d => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
    if (exists(cs) && writable("/usr/local/bin")) {
      const want = await fsp.readFile(cs, "utf8");
      const have = exists("/usr/local/bin/cs") ? await fsp.readFile("/usr/local/bin/cs", "utf8") : "";
      if (want !== have) await fsp.writeFile("/usr/local/bin/cs", want, { mode: 0o755 });
    }
    await fsp.mkdir(CLAUDE_DIR, { recursive: true });
    const sf = path.join(CLAUDE_DIR, "settings.json");
    const s = exists(sf) ? JSON.parse(await fsp.readFile(sf, "utf8")) : {};
    if (s.cleanupPeriodDays === undefined) { s.cleanupPeriodDays = 3650; await fsp.writeFile(sf, JSON.stringify(s, null, 2) + "\n"); }
    const kf = path.join(CLAUDE_DIR, "keybindings.json");
    if (!exists(kf)) await fsp.writeFile(kf, JSON.stringify({
      $schema: "https://www.schemastore.org/claude-code-keybindings.json", $docs: "https://code.claude.com/docs/en/keybindings",
      bindings: [{ context: "Agents", bindings: { left: "agents:previousGroup", right: "agents:nextGroup" } }],
    }, null, 2) + "\n");
  } catch (e) { log("defaults:", e.message); }
}
