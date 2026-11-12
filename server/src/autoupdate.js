// Tells the person when a new release is out, even with the app closed: checks the release track
// (transfer.js → pickRelease) a minute after start and then every 6 hours, and posts one notification
// per release. Tapping it opens the app, whose banner then offers the update.
import fs from "node:fs";
import path from "node:path";
import { prefs, savePrefs, log } from "./config.js";
import { checkUpdate, pickRelease, releaseAsset, ROOT } from "./transfer.js";
import { callNative } from "./hub.js";

const FIRST = +process.env.PA_UPDATE_FIRST_MS || 60_000, EVERY = 6 * 3600_000;   // (tests shorten the first wait)

/** Version code of the installed APK: the app copies its bundle.json next to the server it installs. */
function installedApkCode() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "bundle.json"), "utf8")).versionCode || 0; } catch { return 0; }
}

export async function checkAndNotify() {
  const ch = prefs.updateChannel;
  if (!ch?.github) return null;   // folder and server sources are for developers, who know when they changed something
  const rel = await pickRelease(ch);
  if (prefs.notifiedRelease === rel.tag_name) return null;
  const code = await checkUpdate(ch);
  let apkNewer = false;
  try { apkNewer = ((await (await releaseAsset(ch, rel, "pocket-agent.json")).json()).versionCode || 0) > installedApkCode(); } catch {}
  if (!code.available && !apkNewer) return null;
  await callNative("notify", {
    id: "update", channel: { id: "updates", name: "Updates", importance: "default" }, onlyWhenBackground: true,
    title: `Pocket Agent ${rel.tag_name.replace(/^v/, "")} is available${rel.prerelease ? " (beta)" : ""}`,
    text: "Tap to update", tap: {},
  });
  prefs.notifiedRelease = rel.tag_name; savePrefs();
  log("told the person about", rel.tag_name);
  return rel.tag_name;
}

export function startUpdateChecks() {
  const run = () => checkAndNotify().catch(e => log("update check:", e.message));
  setTimeout(run, FIRST).unref?.();
  setInterval(run, EVERY).unref?.();
}
