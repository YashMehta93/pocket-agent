// Claude plan usage limits (the 5-hour and weekly windows) for the app's usage meter.
// Every reply carries a rate_limit_event with both windows, so the numbers stay current at no cost.
// Claude Code's /usage data (an experimental SDK call, used only if present) adds the per-model weekly limits.
// Each Claude account has its own numbers: cache.usageByAccount[accountId] ("default" is ~/.claude).
import { cache, saveCache, log } from "./config.js";
import { broadcastAll } from "./hub.js";

const AUTO_MS = 5 * 60_000;   // refresh at most this often on its own
const ASKED_MS = 30_000;      // ...and this often when the person opens the details
const USAGE_CALL = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const fetching = new Map();   // account id -> in-flight fetch
const lastTry = new Map();    // account id -> when it last tried

// The numbers belong to the signed-in Claude account: after switching accounts the old ones must not show.
// That check is for the default account only; an extra account has its own login and its own numbers.
const who = () => cache.account?.email || cache.account?.organization || null;
const mine = u => u && (!u.account || !who() || u.account === who());

/** Once, from before accounts existed: the single cache.usage is the default account's. */
function migrate() {
  if (cache.usage !== undefined && cache.usageByAccount?.default === undefined) {
    cache.usageByAccount = { ...(cache.usageByAccount || {}), default: cache.usage };
    delete cache.usage;
  }
}
/** An account's saved numbers; for the default one, only while it's the signed-in account. */
function saved(account) {
  migrate();
  const u = cache.usageByAccount?.[account] || null;
  return account === "default" ? (mine(u) ? u : null) : u;
}

export const getUsage = (account = "default") => saved(account);
/** Every account's numbers, for the accounts list (the default one keeps its email check). */
export function getAllUsage() {
  migrate();
  const out = {};
  for (const id of Object.keys(cache.usageByAccount || {})) out[id] = getUsage(id);
  return out;
}
/** The signed-in account changed: forget the default account's numbers and tell the screens. */
export function accountChanged() {
  migrate();
  if (cache.usageByAccount) delete cache.usageByAccount.default;
  saveCache();
  broadcastAll({ t: "usage", usage: null, account: "default" });
  lastTry.delete("default");
}

function store(next, account = "default") {
  migrate();
  const by = cache.usageByAccount ||= {};
  const prev = by[account];
  const same = JSON.stringify([prev?.windows, prev?.models, prev?.status]) === JSON.stringify([next.windows, next.models, next.status]);
  const usage = { ...next, account: account === "default" ? who() : null, at: Date.now() };
  by[account] = usage;
  saveCache();
  if (!same) broadcastAll({ t: "usage", usage, account });
}

/** A rate_limit_event's info: utilization is 0–1 and times are Unix seconds. Newer Claude Code lists every window. */
export function noteRateLimit(info, account = "default") {
  if (!info) return;
  const prev = saved(account);
  const windows = { ...prev?.windows };
  const put = (k, x) => {
    if (x?.utilization == null && !x?.status) return;
    windows[k] = { used: x.utilization == null ? windows[k]?.used ?? null : Math.round(x.utilization * 100),
      resetsAt: x.resetsAt ? x.resetsAt * 1000 : windows[k]?.resetsAt ?? null, status: x.status || "allowed" };
  };
  if (info.unifiedWindows) for (const [k, x] of Object.entries(info.unifiedWindows)) put(k, x);
  else if (info.rateLimitType) put(info.rateLimitType, info);
  store({ ...prev, windows, status: info.status || "allowed", limit: info.rateLimitType || null,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null }, account);
}

/** Claude Code's /usage data through a live chat's query: utilization is 0–100 and times are ISO strings. */
export async function refreshUsage(q, { asked = false, account = "default" } = {}) {
  if (typeof q?.[USAGE_CALL] !== "function") return getUsage(account);
  if (Date.now() - (lastTry.get(account) || 0) < (asked ? ASKED_MS : AUTO_MS)) return getUsage(account);
  lastTry.set(account, Date.now());
  let p = fetching.get(account);
  if (!p) {
    p = (async () => {
      try {
        const r = await Promise.race([q[USAGE_CALL]({ skipBehaviors: true }), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 15000).unref())]);
        const rl = r?.rate_limits_available ? r.rate_limits : null;
        const prev = saved(account);
        const windows = { ...prev?.windows };
        const time = s => (s ? Date.parse(s) || null : null);
        for (const k of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
          const x = rl?.[k];
          if (x?.utilization != null) windows[k] = { status: "allowed", ...windows[k], used: Math.round(x.utilization), resetsAt: time(x.resets_at) };
          // the service answered but has no 5-hour window yet: nothing used in it, so it's at 0%
          else if (k === "five_hour" && rl && !windows.five_hour?.resetsAt) windows.five_hour = { used: 0, resetsAt: null, status: "allowed" };
        }
        const models = (rl?.model_scoped || []).filter(x => x?.utilization != null)
          .map(x => ({ name: String(x.display_name || "Model"), used: Math.round(x.utilization), resetsAt: time(x.resets_at) }));
        store({ ...prev, windows, models, plan: r?.subscription_type ?? prev?.plan ?? null, available: !!rl }, account);
      } catch (e) { log("usage failed", e?.message); }
      finally { fetching.delete(account); }
    })();
    fetching.set(account, p);
  }
  await p;
  return getUsage(account);
}
