// Several Claude accounts: each extra one is a folder DATA/accounts/<id> used as CLAUDE_CONFIG_DIR.
// It shares chats, settings and skills with ~/.claude through links and keeps only its own login; the default account is ~/.claude itself.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DATA, CLAUDE_DIR, CLAUDE, prefs, savePrefs, log } from "./config.js";
import { profileOf } from "./profiles.js";

export const ACCOUNTS_DIR = path.join(DATA, "accounts");

// The owner's own setup, shared with every account (the same list as the DeepSeek folder in engines.js).
// Never the Claude login file or .claude.json.
export const SHARED = ["projects", "CLAUDE.md", "settings.json", "skills", "agents", "commands", "output-styles", "rules", "plugins"];

const execFileP = promisify(execFile);
const logins = new Map();   // account id → { child, out } for a sign-in waiting for its code
const URL_RE = /https:\/\/[^\s"'<>]*oauth[^\s"'<>]*/;
const LINK_TIMEOUT_MS = 30_000, FINISH_TIMEOUT_MS = 60_000, LOGIN_REAP_MS = 10 * 60_000;
const slug = name => String(name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "account";

/** Every account, default first: { id, name, email, plan, default }. */
export function listAccounts() {
  const def = prefs.defaultAccount || "default";
  const info = prefs.accountInfo?.default || null;
  const all = [
    { id: "default", name: prefs.defaultAccountName || "Default", email: info?.email || null, plan: info?.plan || null },
    ...(prefs.accounts || []),
  ];
  return all.map(a => ({ ...a, default: a.id === def }));
}

/** The config folder of an account: ~/.claude for the default one, DATA/accounts/<id> for the others. */
export function accountDir(id) {
  if (!id || id === "default") return CLAUDE_DIR;
  if ((prefs.accounts || []).some(a => a.id === id)) return path.join(ACCOUNTS_DIR, id);
  throw new Error("Unknown account");
}

/** Links the shared items of ~/.claude into an account folder. Never creates a login file or .claude.json there. */
export function ensureLinks(dir) {
  for (const item of SHARED) {
    const target = path.join(CLAUDE_DIR, item), link = path.join(dir, item);
    if (item === "projects") fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(target)) continue;   // a link to nothing could break Claude Code creating its own
    let st = null; try { st = fs.lstatSync(link); } catch {}
    if (st) continue;
    try { fs.symlinkSync(target, link); }
    catch (e) {
      if (item === "projects") throw e;   // without it the account's chats would vanish from the chat list
      log("accounts: couldn't link", item, e?.message);
    }
  }
}

/** A new account folder (0700) with the shared links, recorded in prefs. */
export function addAccount(name) {
  const id = `${slug(name)}-${randomBytes(2).toString("hex")}`;
  const dir = path.join(ACCOUNTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  ensureLinks(dir);
  const entry = { id, name: String(name ?? "").trim().slice(0, 40) || "Account", email: null, plan: null };
  prefs.accounts = [...(prefs.accounts || []), entry];
  savePrefs();
  return entry;
}

export function renameAccount(id, name) {
  const n = String(name ?? "").trim().slice(0, 40) || "Account";
  if (id === "default") prefs.defaultAccountName = n;
  else {
    accountDir(id);   // throws for an unknown account
    const a = (prefs.accounts || []).find(x => x.id === id);
    if (a) a.name = n;
  }
  savePrefs();
}

/** The account new chats use. Validates the id the same way accountDir() does. */
export function setDefaultAccount(id) {
  accountDir(id);
  prefs.defaultAccount = id;
  savePrefs();
}

/** Removes an account's folder (the links go, not what they point to) and forgets it everywhere. */
export function removeAccount(id) {
  if (id === "default") throw new Error("Can't remove the default account");
  const dir = accountDir(id);
  if (!dir.startsWith(ACCOUNTS_DIR + path.sep)) throw new Error("Not an account folder");
  fs.rmSync(dir, { recursive: true, force: true });
  prefs.accounts = (prefs.accounts || []).filter(a => a.id !== id);
  if (prefs.defaultAccount === id) delete prefs.defaultAccount;
  for (const [sessionId, account] of Object.entries(prefs.chatAccount || {})) if (account === id) delete prefs.chatAccount[sessionId];
  savePrefs();
}

/** Which account a chat runs on: its own choice, else its folder's profile, else the default account. */
export function accountOf(sessionId, cwd) {
  const a = prefs.chatAccount?.[sessionId] || (cwd ? profileOf(cwd).accounts?.local : null) || prefs.defaultAccount || "default";
  return a === "default" || (prefs.accounts || []).some(x => x.id === a) ? a : "default";
}

export function setChatAccount(sessionId, id) {
  accountDir(id);   // throws for an unknown account
  prefs.chatAccount = { ...(prefs.chatAccount || {}), [sessionId]: id };
  savePrefs();
}

/** The environment for a chat or a sign-in on an account: no inherited provider credentials, its own config folder. */
export function accountEnv(id, base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!id || id === "default") delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = accountDir(id);
  return env;
}

/** Whether an account is signed in, and as whom. Never throws: an unknown or broken account reads as signed out. */
export async function authStatus(id, { bin = CLAUDE } = {}) {
  try {
    const { stdout } = await execFileP(bin, ["auth", "status", "--json"], { env: accountEnv(id), timeout: 15_000 });
    const j = JSON.parse(stdout);
    return { loggedIn: !!j.loggedIn, email: j.email || null, plan: j.subscriptionType || null };
  } catch {
    return { loggedIn: false, email: null, plan: null };
  }
}

/** Starts `claude auth login` for an account and resolves with its sign-in URL. */
export function loginStart(id, { bin = CLAUDE } = {}) {
  const prev = logins.get(id);
  if (prev) { try { prev.child.kill(); } catch {} logins.delete(id); }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ["auth", "login", "--claudeai"], { env: accountEnv(id), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { reject(e); return; }
    const out = { text: "" };
    let done = false, timer = null;
    const finish = (err, url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!err) { resolve(url); return; }
      try { child.kill(); } catch {}
      logins.delete(id);
      reject(err);
    };
    const onData = d => {
      out.text += String(d);
      if (done) return;
      const m = out.text.match(URL_RE);
      if (m) finish(null, m[0]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});   // the child may exit before a code is written
    child.on("error", e => finish(e));
    child.on("exit", () => { if (!done) finish(new Error("No sign-in link from Claude Code")); });
    timer = setTimeout(() => { if (!done) finish(new Error("No sign-in link from Claude Code")); }, LINK_TIMEOUT_MS);
    logins.set(id, { child, out });
    const reap = setTimeout(() => {   // an abandoned sign-in doesn't wait forever
      const l = logins.get(id);
      if (l && l.child === child) { try { child.kill(); } catch {} logins.delete(id); }
    }, LOGIN_REAP_MS);
    reap.unref?.();
  });
}

/** Hands a pasted code to the account's waiting sign-in, then checks the result and records it. */
export async function loginCode(id, code, { bin = CLAUDE } = {}) {
  const l = logins.get(id);
  if (!l) throw new Error("Start the sign-in first");
  try { l.child.stdin.write(String(code).trim() + "\n"); } catch {}
  try { await exited(l.child, FINISH_TIMEOUT_MS); }
  catch {
    try { l.child.kill(); } catch {}
    logins.delete(id);
    throw new Error("Sign-in didn't finish");
  }
  logins.delete(id);
  const st = await authStatus(id, { bin });
  if (!st.loggedIn) throw new Error("Sign-in didn't work: " + String(l.out.text || "").slice(-200).trim());
  if (id === "default") {
    prefs.accountInfo = { ...(prefs.accountInfo || {}), default: { email: st.email, plan: st.plan } };
    savePrefs();
  } else {
    const a = (prefs.accounts || []).find(x => x.id === id);
    if (a) { a.email = st.email; a.plan = st.plan; savePrefs(); }
  }
  return st;
}

/** Resolves when the child exits, rejects after `ms`. */
function exited(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    child.once("error", () => { clearTimeout(t); resolve(); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(t); resolve(); }
  });
}
