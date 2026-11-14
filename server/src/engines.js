// Which engine a chat runs on, and the extra query() options that engine needs.
//   claude    Claude Code with the person's Claude login (as always)
//   deepseek  Claude Code pointed at DeepSeek's Anthropic-compatible API, through the key keeper (deepseek.js)
// A chat keeps its engine for life: it's recorded in prefs.chatEngine when the chat starts (and detected from the
// transcript for chats with no record), so a DeepSeek transcript never goes to Anthropic, nor the reverse.
// DeepSeek chats get their own CLAUDE_CONFIG_DIR, with no Claude login in it; the owner's chats, CLAUDE.md, settings,
// skills and memory are linked in, so a DeepSeek chat knows what a Claude chat knows. Worker links live here too.
import fs from "node:fs";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { VERSION, PORT, HOST, DATA, CLAUDE_DIR, SECRETS_DIR, DS_DIR, prefs, savePrefs, log } from "./config.js";
import { ready, readKey, issueToken, dsModel, upstream } from "./deepseek.js";

// ───── the engine record (never trimmed: a lost entry would send a DeepSeek chat to Anthropic) ─────
export const engineOf = id => (id && prefs.chatEngine?.[id]) || null;   // "deepseek" | null (Claude)
export function recordEngine(id, engine) {
  if (!id || engine !== "deepseek" || engineOf(id) === "deepseek") return;
  (prefs.chatEngine ||= {})[id] = "deepseek"; savePrefs();
}
export function copyEngine(from, to) { if (engineOf(from)) recordEngine(to, engineOf(from)); }
export function forget(id) {
  if (!prefs.chatEngine?.[id] && !prefs.chatLinks?.[id]) return;
  delete prefs.chatEngine?.[id]; delete prefs.chatLinks?.[id]; savePrefs();
}
// ───── worker links: child chat → { parent, via, toolUseId, at } ─────
export const linkOf = id => (id && prefs.chatLinks?.[id]) || null;
export function recordLink(child, link) {
  const all = prefs.chatLinks ||= {};
  all[child] = { ...link, at: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > 500) ids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, ids.length - 500).forEach(k => delete all[k]);
  savePrefs();
}

/** A chat with no record: DeepSeek if its newest assistant message came from a deepseek model, null if it has none. */
export async function detectEngine(id) {
  const fromTail = tailEngine(id);   // cheap: the newest lines of the transcript
  if (fromTail !== undefined) return fromTail;
  const ms = await getSessionMessages(id).catch(() => []);
  for (let i = ms.length - 1; i >= 0; i--) { const m = ms[i].message?.model; if (ms[i].type === "assistant" && m && m !== "<synthetic>") return byModel(m); }
  return null;
}
const byModel = m => /^deepseek/i.test(m) ? "deepseek" : "claude";
function tailEngine(id) {
  if (!/^[\w-]+$/.test(id || "")) return undefined;
  const root = path.join(CLAUDE_DIR, "projects");
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return undefined; }
  const file = dirs.map(d => path.join(root, d, id + ".jsonl")).find(f => fs.existsSync(f));
  if (!file) return undefined;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      const m = j.type === "assistant" && j.message?.model;
      if (m && m !== "<synthetic>") return byModel(m);
    }
    return undefined;   // nothing in the newest 512 KB: read the whole chat
  } catch { return undefined; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

export function engineList() { return [{ id: "claude", label: "Claude", ready: true }, { id: "deepseek", label: "DeepSeek", ready: ready() }]; }

// ───── query() options per engine ─────
// Credentials and provider switches a DeepSeek chat must not inherit (it gets its own below).
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|AWS_BEARER_TOKEN)/;

/**
 * Extra query() options for a chat's engine (`s` is the LiveSession; for DeepSeek this issues `s.proxyToken`):
 * {} for Claude (test mode aside); config dir, env, model, effort, settings and the tripwire for DeepSeek.
 */
export function engineOptions(s) {
  if (s.engine !== "deepseek") {
    // Tests only: the Claude engine talks to the fake endpoint, so claude_task can be tested with no Claude account.
    const url = process.env.PA_TEST_ANTHROPIC_URL;
    return url ? { env: { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: process.env.PA_TEST_ANTHROPIC_KEY || "sk-test", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } } : {};
  }
  ensureDsDir();
  const direct = prefs.deepseek?.direct === true || process.env.PA_DS_DIRECT === "1";   // emergency fallback, see deepseek.js
  s.proxyToken = direct ? null : issueToken(s.sessionId);
  const model = dsModel(s.model);
  // The key keeper is on this server; a DeepSeek chat runs on this phone, so loopback reaches it however we listen.
  const host = /^(0\.0\.0\.0|::|localhost|127\.0\.0\.1)$/.test(HOST) ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  const base = direct ? upstream() : `http://${host}:${PORT}/deepseek`;
  return {
    model,
    // Not CLAUDE_CODE_EFFORT_LEVEL (DeepSeek's recipe): Claude Code lets that variable beat the chat's own effort and
    // then refuses to change effort mid-chat. "max" is the recipe's level; the effort chip changes it.
    effort: s.effort || "max",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k))),
      CLAUDE_CONFIG_DIR: DS_DIR,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: direct ? readKey() || "" : s.proxyToken,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash", CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",   // otherwise Claude Code also calls api.anthropic.com (verified)
      CLAUDE_AGENT_SDK_CLIENT_APP: `pocket-agent/${VERSION}`, PA_ENGINE: "deepseek" },
    // The flag layer beats the owner's (shared) settings.json: commits and PRs don't claim Claude wrote them, and
    // nothing in a settings file can point the chat somewhere other than the key keeper.
    settings: { includeCoAuthoredBy: false, attribution: { commit: "", pr: "", sessionUrl: false },
      env: { ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
    hooks: { PreToolUse: [{ hooks: [tripwire] }] },
  };
}

// ───── the DeepSeek chats' config dir ─────
// The owner's own setup, shared with DeepSeek chats (owner's call): chats and memory (projects/), CLAUDE.md, settings,
// skills, agents, commands, output styles, rules, plugins. Never the Claude login (.credentials.json) or .claude.json.
const SHARED = ["projects", "CLAUDE.md", "settings.json", "skills", "agents", "commands", "output-styles", "rules", "plugins"];
/** Makes DS_DIR (0700) and links the shared items into it. Called before every DeepSeek chat starts, so it follows new ones. */
export function ensureDsDir() {
  fs.mkdirSync(DS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true });
  for (const name of SHARED) {
    const target = path.join(CLAUDE_DIR, name), link = path.join(DS_DIR, name);
    try {
      if (!fs.existsSync(target)) continue;   // a link to nothing could break Claude Code creating its own
      let st = null; try { st = fs.lstatSync(link); } catch {}
      if (st?.isSymbolicLink()) { if (fs.readlinkSync(link) === target) continue; fs.unlinkSync(link); }
      else if (st) { const aside = `${link}.old-${Date.now()}`; fs.renameSync(link, aside); log("deepseek: moved", link, "to", aside); }
      fs.symlinkSync(target, link);
    } catch (e) {
      if (name === "projects") throw e;   // without it DeepSeek chats would vanish from the chat list
      log("deepseek: couldn't link", name, e?.message);
    }
  }
  fs.rmSync(path.join(DS_DIR, ".credentials.json"), { force: true });   // never a Claude login here
}

// ───── the tripwire: a PreToolUse hook in DeepSeek chats (works in Bypass too) ─────
// Honest limit: a determined agent can get around a pattern list; there's no real sandbox in proot.
const SECRET = [/\.pocket-agent\/(secrets|token)\b/, /\.credentials\.json/, /\/proc\/[^/\s"]+\/environ/, /github-token/, /\.config\/ado\//,
  /\.git-credentials/, /\.keystore\b/, /release-key\.pem/, /\.ssh\/id_/];
export async function tripwire(input) {
  const s = JSON.stringify(input?.tool_input ?? "");
  const own = [SECRETS_DIR, path.join(DATA, "token")];   // the same files when PA_DATA is somewhere else
  return SECRET.some(r => r.test(s)) || own.some(p => s.includes(p)) ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "Pocket Agent keeps this file away from DeepSeek." } } : {};
}
