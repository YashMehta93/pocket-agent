// Every server describes the machine it runs on: a hub (another Pocket Agent server that connects to it) can
// show it, route to it and check versions from this. The stable part lives in prefs.environment
// ({ id, name, reaches }); the rest is read from the process and the other modules each time.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { VERSION, prefs, savePrefs } from "./config.js";
import { engineList } from "./engines.js";
import { listAccounts } from "./accounts.js";
import { broadcastAll } from "./hub.js";

/** Raise this whenever the WebSocket protocol changes in a way older apps can't handle. */
export const PROTOCOL = 1;

/** What this server can do. Later tasks add "devices" and "hub". */
export const CAPS = ["sessions", "files", "workers", "accounts", "environment"];

/** The machine this server runs on: android-linux (the app's Linux, or Termux), windows, macos, or linux. */
export function detectOs() {
  if (fs.existsSync("/system/build.prop") || process.env.ANDROID_ROOT || (process.env.PREFIX || "").includes("com.termux")) return "android-linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

const NAME = { "android-linux": "Phone", windows: "Windows PC", macos: "Mac", linux: "Linux computer" };
const defaultName = os => NAME[os] || NAME.linux;

/** The saved environment, creating its id (and any missing field) once. */
function saved() {
  const e = prefs.environment && typeof prefs.environment === "object" ? prefs.environment : {};
  let changed = false;
  if (!e.id) { e.id = "env-" + randomBytes(6).toString("hex"); changed = true; }   // never a hostname
  if (!e.name) { e.name = defaultName(detectOs()); changed = true; }
  if (!Array.isArray(e.reaches)) { e.reaches = []; changed = true; }
  prefs.environment = e;
  if (changed) savePrefs();
  return e;
}

/** This server, described in full (what a hub shows and checks). */
export function environment() {
  const e = saved();
  return {
    id: e.id, name: e.name, os: detectOs(),
    shell: path.basename(process.env.SHELL || process.env.ComSpec || "sh"),
    engines: engineList().filter(x => x.ready).map(x => x.id),
    accounts: listAccounts().map(a => a.id),
    reaches: e.reaches,
    limits: { symlinks: process.platform !== "win32" },
    protocol: PROTOCOL, version: VERSION, caps: CAPS,
  };
}

/** Changes the name and/or reaches after checking them, saves, tells every client, and returns the result. */
export function setEnvironment({ name, reaches } = {}) {
  const e = saved();
  let newName = e.name, newReaches = e.reaches;
  if (name !== undefined) {
    const n = typeof name === "string" ? name.trim() : "";
    if (n.length < 1 || n.length > 40) throw new Error("Give it a name of 1–40 characters");
    newName = n;
  }
  if (reaches !== undefined) {
    if (!Array.isArray(reaches) || reaches.length > 8) throw new Error("Give up to 8 places this device reaches");
    newReaches = reaches.map(r => {
      const t = typeof r === "string" ? r.trim() : "";
      if (t.length < 1 || t.length > 24 || !/^[\w .-]+$/.test(t)) throw new Error("Each place must be 1–24 characters: letters, digits, spaces, dots, dashes or underscores");
      return t;
    });
  }
  e.name = newName; e.reaches = newReaches;
  savePrefs();
  broadcastAll({ t: "environment", environment: environment() });
  return environment();
}
