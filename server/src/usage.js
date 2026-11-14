// Claude plan usage limits (the 5-hour and weekly windows) for the app's usage meter.
// Every reply carries a rate_limit_event with both windows, so the numbers stay current at no cost.
// Claude Code's /usage data (an experimental SDK call, used only if present) adds the per-model weekly limits.
import { cache, saveCache, log } from "./config.js";
import { broadcastAll } from "./hub.js";

const AUTO_MS = 5 * 60_000;   // refresh at most this often on its own
const ASKED_MS = 30_000;      // ...and this often when the person opens the details
const USAGE_CALL = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
let fetching = null, lastTry = 0;

export const getUsage = () => cache.usage || null;

function store(next) {
  const same = JSON.stringify([cache.usage?.windows, cache.usage?.models, cache.usage?.status]) === JSON.stringify([next.windows, next.models, next.status]);
  cache.usage = { ...next, at: Date.now() };
  saveCache();
  if (!same) broadcastAll({ t: "usage", usage: cache.usage });
}

/** A rate_limit_event's info: utilization is 0–1 and times are Unix seconds. Newer Claude Code lists every window. */
export function noteRateLimit(info) {
  if (!info) return;
  const windows = { ...cache.usage?.windows };
  const put = (k, x) => {
    if (x?.utilization == null && !x?.status) return;
    windows[k] = { used: x.utilization == null ? windows[k]?.used ?? null : Math.round(x.utilization * 100),
      resetsAt: x.resetsAt ? x.resetsAt * 1000 : windows[k]?.resetsAt ?? null, status: x.status || "allowed" };
  };
  if (info.unifiedWindows) for (const [k, x] of Object.entries(info.unifiedWindows)) put(k, x);
  else if (info.rateLimitType) put(info.rateLimitType, info);
  store({ ...cache.usage, windows, status: info.status || "allowed", limit: info.rateLimitType || null,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null });
}

/** Claude Code's /usage data through a live chat's query: utilization is 0–100 and times are ISO strings. */
export async function refreshUsage(q, { asked = false } = {}) {
  if (typeof q?.[USAGE_CALL] !== "function") return getUsage();
  if (Date.now() - lastTry < (asked ? ASKED_MS : AUTO_MS)) return getUsage();
  lastTry = Date.now();
  fetching ||= (async () => {
    try {
      const r = await Promise.race([q[USAGE_CALL]({ skipBehaviors: true }), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 15000).unref())]);
      const rl = r?.rate_limits_available ? r.rate_limits : null;
      const windows = { ...cache.usage?.windows };
      const time = s => (s ? Date.parse(s) || null : null);
      for (const k of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]) {
        const x = rl?.[k];
        if (x?.utilization != null) windows[k] = { status: "allowed", ...windows[k], used: Math.round(x.utilization), resetsAt: time(x.resets_at) };
      }
      const models = (rl?.model_scoped || []).filter(x => x?.utilization != null)
        .map(x => ({ name: String(x.display_name || "Model"), used: Math.round(x.utilization), resetsAt: time(x.resets_at) }));
      store({ ...cache.usage, windows, models, plan: r?.subscription_type ?? cache.usage?.plan ?? null, available: !!rl });
    } catch (e) { log("usage failed", e?.message); }
    finally { fetching = null; }
  })();
  await fetching;
  return getUsage();
}
