// Profiles: whose work a chat is. A profile groups folders (workspaces), the Claude account its chats use,
// environment variables and a secrets folder of its own. Stored in prefs.profiles / prefs.defaultProfile.
//   - a chat's profile comes from its folder: the longest workspace that contains it, else the default profile
//   - with no stored profiles there is one implicit "personal" profile, and nothing is written until a save
import fs from "node:fs";
import path from "node:path";
import { SECRETS_DIR, prefs, savePrefs } from "./config.js";
import { broadcastAll } from "./hub.js";

export const COLORS = ["teal", "blue", "violet", "rose", "amber", "green", "slate"];

const ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_KEYS = new Set(["HOME", "PATH"]);
const RESERVED_PREFIX = /^(ANTHROPIC_|CLAUDE_|PA_)/;
const MAX_NAME = 30, MAX_ENV = 30, MAX_VALUE = 2000;

/** The profile list defaults to one "personal" profile; it isn't stored until something is saved. */
const PERSONAL = () => ({ id: "personal", name: "Personal", color: "teal", workspaces: [], accounts: {}, env: {} });
const copy = p => ({ id: p.id, name: p.name, color: p.color, workspaces: [...(p.workspaces || [])], accounts: { ...(p.accounts || {}) }, env: { ...(p.env || {}) } });

/** Every profile, default-profile-first order as stored (or the single implicit one). */
export function listProfiles() {
  const all = Array.isArray(prefs.profiles) ? prefs.profiles : [];
  return all.length ? all.map(copy) : [PERSONAL()];
}

/** The id of the default profile (always one that exists). */
export function defaultProfileId() {
  const all = listProfiles();
  return all.some(p => p.id === prefs.defaultProfile) ? prefs.defaultProfile : all[0].id;
}

/** The profile a folder belongs to: its longest matching workspace, else the default profile. */
export function profileOf(cwd) {
  const all = listProfiles();
  const dir = cwd ? path.resolve(String(cwd)) : null;
  if (dir) {
    let best = null, bestLen = -1;
    for (const p of all) for (const w of p.workspaces) {
      const ws = path.resolve(w);
      if ((dir === ws || dir.startsWith(ws + "/")) && ws.length > bestLen) { best = p; bestLen = ws.length; }
    }
    if (best) return best;
  }
  return all.find(p => p.id === defaultProfileId()) || all[0];
}

/** A profile's own secrets folder (0700); "$SECRETS" in its env means this. */
export const secretsDir = id => path.join(SECRETS_DIR, "profiles", id);

const broadcastProfiles = () => broadcastAll({ t: "profiles", profiles: listProfiles(), defaultProfile: defaultProfileId() });

/** A new profile's id: the name lowercased, non-alphanumerics to "-", de-duplicated with -2, -3… */
function slugId(name, taken) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
  if (!base) base = "profile";
  if (!/^[a-z]/.test(base)) base = `p-${base}`.slice(0, 24).replace(/-+$/g, "");
  let id = base;
  for (let n = 2; taken.has(id); n++) {
    const suffix = `-${n}`;
    id = base.slice(0, 24 - suffix.length).replace(/-+$/g, "") + suffix;
  }
  return id;
}

/**
 * Validates and saves a profile (insert or update by id), creates its secrets folder, broadcasts the new list.
 * `accountIds` are the Claude account ids that exist (`default` is always allowed); the handler passes them from
 * accounts.js, which keeps this file free of an import cycle.
 */
export function saveProfile(p, accountIds = ["default"]) {
  if (!p || typeof p !== "object") throw new Error("No profile to save");
  const all = (Array.isArray(prefs.profiles) ? prefs.profiles : []).map(copy);

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) throw new Error("A profile needs a name");
  if (name.length > MAX_NAME) throw new Error(`A profile's name is at most ${MAX_NAME} characters`);

  const asked = typeof p.id === "string" ? p.id.trim() : "";
  if (asked && !ID_RE.test(asked)) throw new Error("A profile id is lowercase letters, numbers and dashes, up to 24 characters");
  if (asked && !all.some(x => x.id === asked)) {
    // Keep the default "personal" profile that exists implicitly before the first save.
    if (!all.length && asked !== "personal") all.push(PERSONAL());
  } else if (!asked && !all.length) all.push(PERSONAL());
  const id = asked || slugId(name, new Set(all.map(x => x.id)));
  const original = all.find(x => x.id === id) || null;

  const color = COLORS.includes(p.color) ? p.color : "teal";

  const workspaces = [];
  for (const raw of Array.isArray(p.workspaces) ? p.workspaces : []) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("A workspace must be a folder path");
    const w = path.resolve(raw.trim());
    let st; try { st = fs.statSync(w); } catch { throw new Error(`Folder not found: ${w}`); }
    if (!st.isDirectory()) throw new Error(`Not a folder: ${w}`);
    if (workspaces.includes(w)) continue;
    const other = all.find(x => x.id !== id && x.workspaces.some(o => path.resolve(o) === w));
    if (other) throw new Error(`${w} is already in ${other.name}`);
    workspaces.push(w);
  }

  const accounts = {};
  for (const [key, value] of Object.entries(p.accounts && typeof p.accounts === "object" ? p.accounts : {})) {
    if (key !== "local") throw new Error('Only "local" can be set in a profile for now');
    if (typeof value !== "string" || (value !== "default" && !accountIds.includes(value))) throw new Error("Unknown account");
    accounts.local = value;
  }

  const env = {};
  const askedEnv = p.env && typeof p.env === "object" ? p.env : {};
  const keys = Object.keys(askedEnv);
  if (keys.length > MAX_ENV) throw new Error(`A profile has at most ${MAX_ENV} environment variables`);
  for (const key of keys) {
    if (!KEY_RE.test(key)) throw new Error(`Bad environment variable name: ${key}`);
    if (RESERVED_KEYS.has(key) || RESERVED_PREFIX.test(key)) throw new Error(`${key} can't be set in a profile`);
    const value = askedEnv[key];
    if (typeof value !== "string") throw new Error(`${key} must be text`);
    if (value.length > MAX_VALUE) throw new Error(`${key} is too long (at most ${MAX_VALUE} characters)`);
    env[key] = value;
  }

  const profile = { id, name, color, workspaces, accounts, env };
  if (original) Object.assign(original, profile); else all.push(profile);

  const dir = secretsDir(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}

  prefs.profiles = all;
  if (!all.some(x => x.id === prefs.defaultProfile)) prefs.defaultProfile = all[0].id;
  savePrefs();
  broadcastProfiles();
  return copy(profile);
}

/** Removes a profile (but never the last one, and never its secrets folder). Returns where they were kept. */
export function removeProfile(id) {
  const all = listProfiles();
  const i = all.findIndex(p => p.id === id);
  if (i < 0) throw new Error("Unknown profile");
  if (all.length <= 1) throw new Error("Keep at least one profile");
  const [gone] = all.splice(i, 1);
  prefs.profiles = all;
  if (!all.some(p => p.id === prefs.defaultProfile)) prefs.defaultProfile = all[0].id;
  savePrefs();
  broadcastProfiles();
  return { ok: true, keptSecrets: secretsDir(gone.id) };
}

/** Makes a profile the default (for folders no workspace claims). */
export function setDefaultProfile(id) {
  if (!listProfiles().some(p => p.id === id)) throw new Error("Unknown profile");
  prefs.defaultProfile = id;
  savePrefs();
  broadcastProfiles();
  return id;
}

/** A chat's environment: `base` plus the profile's own values, with "$SECRETS" pointing at its secrets folder. */
export function chatEnv(profile, base = process.env) {
  const dir = secretsDir(profile.id);
  const env = {};
  for (const [key, value] of Object.entries(profile.env || {})) env[key] = String(value).split("$SECRETS").join(dir);
  return { ...base, ...env, PA_PROFILE: profile.id, PA_PROFILE_SECRETS: dir };
}

/**
 * A PreToolUse hook (same shape as engines.js `tripwire`) that keeps one profile's chat out of the other
 * profiles' secrets folders. It's a guard, not a sandbox.
 */
export function profileGuard(profile) {
  return async function profileGuardHook(input) {
    const text = JSON.stringify(input?.tool_input ?? "");
    for (const other of listProfiles()) {
      if (other.id === profile.id) continue;
      if (text.includes(secretsDir(other.id)) || text.includes(`secrets/profiles/${other.id}`)) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
          permissionDecisionReason: `That folder belongs to the ${other.name} profile.` } };
      }
    }
    return {};
  };
}
