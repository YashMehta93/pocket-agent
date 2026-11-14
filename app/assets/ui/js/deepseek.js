// deepseek.js — DeepSeek in the app: the engine chip and its sheet, Settings → DeepSeek and the key sheet, the
// DeepSeek part of the Usage sheet, worker links, the sheet that asks before a handoff, and the handoff's quiet line
// in the chat (agents.js has the Agents tab those lines open).
// The server owns the key, the prices and the spend (server/src/deepseek.js); this file only shows them.
// Claude-only users (no key) see none of it except the Settings category.
"use strict";

const DS_TOOL = "mcp__pocket__deepseek_task", CLAUDE_TOOL = "mcp__pocket__claude_task";
const ENGINE_NAME = { claude: "Claude", deepseek: "DeepSeek" };
// Used only until the server's list arrives (hello.deepseek.models)
const DS_MODELS_FALLBACK = [
  { value: "deepseek-flash[1m]", displayName: "DeepSeek Flash", description: "Fast and cheap. Sees images." },
  { value: "deepseek-v4-pro[1m]", displayName: "DeepSeek V4 Pro", description: "Stronger, about 3–4× the price. No images." },
];
state.deepseek = null;   // the server's DeepSeek status (docs/PROTOCOL.md); null when the server doesn't know DeepSeek
state.engines = null;
state.links = {};        // worker chat id -> { parent, engine, title, toolUseId, at, result }, from `link` events

function isDelegationTool(name) { return name === DS_TOOL || name === CLAUDE_TOOL; }

// ───────────── formatting ─────────────
function dsMoney(n, currency) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "–";
  const sym = currency === "CNY" ? "¥" : !currency || currency === "USD" ? "$" : currency + " ";
  if (v > 0 && v < 0.001) return "<" + sym + "0.001";
  return sym + (v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2));
}
const dsCap = n => dsMoney(n).replace(/\.00$/, "");   // a limit reads "$3", not "$3.00"
function dsAgo(at) {
  if (!at) return "";
  const s = (Date.now() - at) / 1000;
  return s < 60 ? "just now" : s < 604800 ? relTime(at) + " ago" : "on " + relTime(at);
}
/** A time the price changes, as the phone shows times: "3:30 PM", "6:30 AM tomorrow", "Mon 6:30 AM". */
function dsWhen(ms) {
  const d = new Date(ms), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return days <= 0 ? t : days === 1 ? t + " tomorrow" : d.toLocaleDateString([], { weekday: "short" }) + " " + t;
}
function dsPriceLine(p = state.deepseek?.price) {
  if (!p) return "";
  const w = p.until ? dsWhen(p.until) : "";
  return p.peak ? "Peak price now" + (w ? " · half price from " + w : "") : "Half price now" + (w ? " · until " + w : "");
}
function dsBalanceText(d = state.deepseek) {
  const b = d?.balance;
  if (b?.available === false) return "Out of credit";
  if (b?.total != null) return dsMoney(b.total, b.currency) + " left";
  return d?.balanceError ? "Couldn't check" : "Unknown";
}
/** "Today $0.12 · this month $1.40", with "of $3" when there's a daily limit (there's none by default). */
function dsSpentText(sp = state.deepseek?.spend) {
  if (!sp) return "Nothing yet";
  return `Today ${dsMoney(sp.today || 0)}${sp.cap ? " of " + dsCap(sp.cap) : ""} · this month ${dsMoney(sp.month || 0)}`;
}
function dsFirstLine(s) { return String(s || "").split("\n").map(l => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean)?.slice(0, 60) || ""; }

// ───────────── engines and models ─────────────
function dsModels() { return state.deepseek?.models?.length ? state.deepseek.models : DS_MODELS_FALLBACK; }
function isDsModel(m) { return /^deepseek-/i.test(m || ""); }
const dsBare = m => String(m || "").replace(/\[1m\]$/i, "");
/** "deepseek-flash", "deepseek-flash[1m]" → "DeepSeek Flash" */
function dsModelName(m) {
  const hit = dsModels().find(x => dsBare(x.value) === dsBare(m));
  return hit ? hit.displayName : /v4-pro/i.test(m || "") ? "DeepSeek V4 Pro" : "DeepSeek Flash";
}
/** The composer already says DeepSeek on the engine chip, so its model chip says just "Flash" or "V4 Pro". */
const dsShortModel = m => dsModelName(m).replace(/^DeepSeek /, "");
function dsDefaultModel() { return state.deepseek?.settings?.defaultModel || dsModels()[0].value; }

/** The engine a chat runs on: "claude" or "deepseek". */
function chatEngine(id = state.current?.sessionId) {
  const cur = state.current;
  if (cur && id === cur.sessionId && cur.engine) return cur.engine;
  const s = state.sessions.find(x => x.sessionId === id);
  return s?.engine || state.liveInfo[id]?.engine || "claude";
}
function defaultEngine() { return state.deepseek?.ready && state.defaults?.engine === "deepseek" ? "deepseek" : "claude"; }
/** Gives a new chat an engine with that engine's model and effort. DeepSeek chats have no Auto mode. */
function applyEngine(cur, engine) {
  const d = state.defaults || {};
  cur.engine = engine;
  Object.assign(cur, engine === "deepseek" ? { model: dsDefaultModel(), effort: state.deepseek?.settings?.effort || null } : { model: d.model || null, effort: d.effort || null });
  if (engine === "deepseek" && cur.permissionMode === "auto") cur.permissionMode = "default";
}
function setNewChatEngine(engine) {
  const cur = state.current;
  if (!cur?.isNew) return;
  applyEngine(cur, engine);
  cur.engineChosen = true;
  updateComposer(); updateHeader();
}

/** From `hello`: the engines and the DeepSeek status. A fresh new chat takes the default engine now that it's known. */
function dsHello(hello) {
  state.engines = hello.engines || null;
  state.deepseek = hello.deepseek || null;
  const cur = state.current;
  if (cur?.isNew && !cur.engineChosen && cur.engine !== defaultEngine()) applyEngine(cur, defaultEngine());
  renderEngineChip();
}
function dsSetStatus(d) {
  if (!d) return;
  state.deepseek = { ...(state.deepseek || {}), ...d };
  // a new chat can't start on DeepSeek without a key
  const cur = state.current;
  if (!state.deepseek.ready && cur?.isNew && cur.engine === "deepseek") { applyEngine(cur, "claude"); updateComposer(); updateHeader(); }
  dsChanged();
}
/** Shows new numbers wherever they're on screen: the chip, the Usage sheet, an open Settings → DeepSeek page. */
function dsChanged() {
  renderEngineChip();
  if (sheet.key === "usage" && typeof usageRedraw === "function") usageRedraw();
  const bal = $("#ds-bal"); if (bal) bal.textContent = dsBalanceRow();
  const sp = $("#ds-spent"); if (sp) sp.textContent = dsSpentRow();
}

// ───────────── engine chip and sheet ─────────────
/** Shown where it says something: a new chat (once a key is saved, the engine is a choice) and every DeepSeek chat.
 *  An existing Claude chat runs on the default and can't change, so it keeps the composer as it was. */
function renderEngineChip() {
  const chip = $("#chip-engine");
  if (!chip) return;
  const ds = chatEngine() === "deepseek";
  chip.hidden = !(ds || (state.deepseek?.ready && state.current?.isNew));
  chip.textContent = ENGINE_NAME[ds ? "deepseek" : "claude"];
  chip.classList.toggle("engine-ds", ds);
  chip.setAttribute("aria-label", "Engine: " + chip.textContent);
}
function engineSheet() {
  const cur = state.current;
  if (!cur) return;
  const eng = chatEngine(), ready = !!state.deepseek?.ready;
  if (!cur.isNew) {
    const other = eng === "deepseek" ? "claude" : "deepseek", can = other === "claude" || ready;
    const b = sheet.open(`<h2>This chat runs on ${ENGINE_NAME[eng]}</h2><div class="sub">A chat stays on one engine.</div>
      <div class="btns row2"><button class="btn ghost" data-a="close">Close</button>${can ? `<button class="btn primary" data-a="new">New ${ENGINE_NAME[other]} chat here</button>` : ""}</div>`, { key: "engine" });
    b.querySelector('[data-a="close"]').onclick = () => sheet.close(true);
    b.querySelector('[data-a="new"]')?.addEventListener("click", () => { sheet.close(true); newChat(cur.cwd, other); });
    return;
  }
  const opts = [
    { id: "claude", title: "Claude", desc: "Your Claude plan." },
    { id: "deepseek", title: "DeepSeek", desc: !ready ? "Add your key in Settings first"
      : `Pay per use from your DeepSeek credit${state.deepseek.balance?.total != null ? " (" + dsBalanceText() + ")" : ""}. Your messages, files and memory go to DeepSeek.` },
  ];
  const b = sheet.open(`<h2>Run this chat on</h2><div id="eng-opts"></div>`, { key: "engine" });
  for (const o of opts) {
    const on = o.id === eng;
    const el = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div></div><div class="od"></div></div></button>`);
    el.querySelector(".ot div").textContent = o.title;
    el.querySelector(".od").textContent = o.desc;
    el.onclick = () => {
      sheet.close(true);
      if (o.id === "deepseek" && !ready) return openSettings("deepseek");
      setNewChatEngine(o.id);
    };
    b.querySelector("#eng-opts").append(el);
  }
}
$("#chip-engine").onclick = () => engineSheet();

/** The model sheet of a DeepSeek chat: DeepSeek's models, and efforts low/high/max (max is DeepSeek's default). */
function dsModelSheet() {
  const cur = currentSettings();
  const b = sheet.open(`<h2>Model</h2><div id="models"></div><h2 style="margin-top:16px">Effort</h2><div class="sub">Higher effort thinks longer and costs more.</div><div class="seg" id="efforts"></div>`);
  for (const m of dsModels()) {
    const on = dsBare(m.value) === dsBare(cur.model || dsDefaultModel());
    const o = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div></div><div class="od"></div></div></button>`);
    o.querySelector(".ot div").textContent = m.displayName;
    o.querySelector(".od").textContent = m.description || "";
    o.onclick = () => { sheet.close(true); applySetting({ model: m.value }); };
    b.querySelector("#models").append(o);
  }
  for (const e of ["low", "high", "max"]) {
    const x = h(`<button class="${(cur.effort || "max") === e ? "on" : ""}">${e}</button>`);
    x.onclick = () => { sheet.close(true); applySetting({ effort: e === "max" ? null : e }); };
    b.querySelector("#efforts").append(x);
  }
}
/** V4 Pro gets a placeholder instead of each image. */
function dsImageNote() {
  if (chatEngine() === "deepseek" && /v4-pro/i.test(currentSettings().model || "") && attachments.some(a => a.kind === "image")) toast("V4 Pro can't see images. Flash can.", 3500);
}

// ───────────── Settings → DeepSeek ─────────────
const dsBalanceRow = () => { const b = state.deepseek?.balance; return dsBalanceText() + (b?.at && b.available !== false ? " · " + dsAgo(b.at) : ""); };
const dsSpentRow = () => dsSpentText() + (state.deepseek?.spend?.cap ? "" : " · no daily limit");
function dsSettingsSection() {
  const d = state.deepseek;
  if (!d) return null;    // a server without DeepSeek support (an older Termux or PC server)
  const set = d.settings || {}, folders = set.blockedFolders || [];
  const swRow = (k, label, small, keys) => item(`<div class="set-row"><div class="l">${label}<small>${small}</small></div><button class="switch ${set[k] !== false ? "on" : ""}" data-ds="${k}" role="switch" aria-checked="${set[k] !== false}" aria-label="${label}"></button></div>`, keys);
  const segRow = (id, label, opts, cur, keys) => item(`<div class="set-row"><div class="l">${label}</div></div><div class="seg" id="${id}">${opts.map(([v, l]) => `<button data-v="${esc(v)}" class="${v === cur ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`, keys);
  const foot = t => item(`<p class="set-foot">${t}</p>`, "deepseek key private backup");
  return {
    id: "deepseek", title: "DeepSeek", icon: "key",
    summary: d.ready ? [dsBalanceText(), dsShortModel(set.defaultModel || dsDefaultModel())].join(" · ") : "Not set up",
    html: () => !d.ready
      ? item(`<div class="set-row"><div class="l">API key<small>Not set</small></div><button class="chip" id="ds-key">Add</button></div>`, "deepseek api key token")
        + foot("Run chats on DeepSeek, paid per use from your DeepSeek credit. Get a key at platform.deepseek.com. It stays on this phone in a private file, and backups skip it.")
      : item(`<div class="set-row"><div class="l">API key<small>Saved · ends ${esc(d.keyHint || "····")}</small></div><button class="chip" id="ds-key">Change</button></div>`, "deepseek api key token")
        + item(`<div class="set-row"><div class="l">Balance<small id="ds-bal">${esc(dsBalanceRow())}</small></div><button class="chip" id="ds-refresh">Refresh</button></div>`, "credit money balance top up")
        + item(`<div class="set-row"><div class="l">Spent<small id="ds-spent">${esc(dsSpentRow())}</small></div><button class="chip" id="ds-limit">Limit</button></div>`, "spend cost limit cap money daily")
        + segRow("ds-model", "Model for new DeepSeek chats", dsModels().map(m => [m.value, dsShortModel(m.value)]), set.defaultModel || dsDefaultModel(), "model flash pro")
        + segRow("ds-engine", "New chats start on", [["claude", "Claude"], ["deepseek", "DeepSeek"]], state.defaults?.engine === "deepseek" ? "deepseek" : "claude", "default engine")
        + swRow("toDeepseek", "Claude can send work to DeepSeek", "Asks you first, except in Bypass. The worker gets the chat's mode.", "worker delegate task")
        + swRow("toClaude", "DeepSeek can ask Claude", "Asks you first, except in Bypass. Uses your Claude plan.", "worker delegate claude ask")
        + item(`<div class="set-row"><div class="l">Keep DeepSeek out of<small id="ds-folders-v">${folders.length ? esc(folders.length === 1 ? shortPath(folders[0]) : folders.length + " folders") : "No folders"}</small></div><button class="chip" id="ds-folders">Change</button></div>`, "privacy folder office work block")
        + item(`<div class="set-row"><div class="l">Remove key<small>DeepSeek chats stop until you add one again</small></div><button class="chip danger" id="ds-remove">Remove</button></div>`, "delete key")
        + foot("Your key stays on this phone in a private file. Backups skip it."),
  };
}
/** Hooks up the rows above (wireSettings calls this for every settings page and search result). */
function wireDsSettings(root) {
  const on = (sel, fn) => root.querySelector(sel)?.addEventListener("click", fn);
  on("#ds-key", () => keySheet());
  on("#ds-refresh", () => dsRefresh(true, true));
  on("#ds-limit", () => dsLimitPrompt());
  on("#ds-folders", () => dsFoldersPrompt());
  on("#ds-remove", () => dsRemoveKey());
  seg(root, "#ds-model", v => dsSaveSettings({ defaultModel: v }));
  seg(root, "#ds-engine", v => dsDefaultEngine(v));
  root.querySelectorAll(".switch[data-ds]").forEach(b => b.onclick = async () => {
    const v = !b.classList.contains("on");
    b.classList.toggle("on", v); b.setAttribute("aria-checked", v);
    if (!await dsSaveSettings({ [b.dataset.ds]: v }, true)) { b.classList.toggle("on", !v); b.setAttribute("aria-checked", !v); }
  });
  const b = state.deepseek?.balance;
  if (root.querySelector("#ds-bal") && (!b?.at || Date.now() - b.at > 60e3)) dsRefresh(true);
}
async function dsRefresh(refresh, loud) {
  if (loud) { const el = $("#ds-bal"); if (el) el.textContent = "Checking…"; }
  try { dsSetStatus((await conn.call("deepseek.status", { refresh })).deepseek); }
  catch (e) { if (loud) { toast(e.message); dsChanged(); } }
  if (loud && state.deepseek?.balanceError) toast(state.deepseek.balanceError, 4000);
}
/** Saves DeepSeek settings; `quiet` keeps the page as it is (a switch already shows its new state). */
async function dsSaveSettings(patch, quiet) {
  try { dsSetStatus((await conn.call("deepseek.settings", { settings: patch })).deepseek); }
  catch (e) { toast(e.message, 4000); if (!quiet) openSettingsRefresh(); return false; }
  if (!quiet) openSettingsRefresh();
  return true;
}
async function dsDefaultEngine(engine) {
  try { state.defaults = (await conn.call("defaults.set", { defaults: { engine } })).defaults; } catch (e) { return toast(e.message); }
  // like the other defaults, a new chat on screen takes it at once
  if (state.current?.isNew && !input.value.trim()) setNewChatEngine(engine);
}
async function dsLimitPrompt() {
  const cap = state.deepseek?.settings?.dailyCapUsd || 0;
  const v = await promptSheet({ title: "Daily DeepSeek limit", value: cap ? String(cap) : "", placeholder: "Dollars a day; empty for no limit", ok: "Save" });
  if (v === null) return;
  const n = v === "" ? 0 : Number(v.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1000) return toast("Enter dollars from 0 to 1000, or leave it empty for no limit", 4000);
  if (await dsSaveSettings({ dailyCapUsd: n })) toast(n ? `DeepSeek stops at ${dsCap(n)} a day` : "No daily limit");
}
async function dsFoldersPrompt() {
  const cur = state.deepseek?.settings?.blockedFolders || [];
  const v = await promptSheet({ title: "Keep DeepSeek out of", multiline: true, ok: "Save", value: cur.map(shortPath).join("\n"), placeholder: "One folder per line, like ~/projects/office" });
  if (v === null) return;
  const list = v.split("\n").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean).map(p => p === "~" || p.startsWith("~/") ? state.home + p.slice(1) : p);
  if (list.some(p => !p.startsWith("/"))) return toast("Use whole paths, like ~/projects/office", 4000);
  await dsSaveSettings({ blockedFolders: list });
}
async function dsRemoveKey() {
  if (!await confirmSheet({ title: "Remove the DeepSeek key?", text: "DeepSeek chats can't run until you add a key again. Your chats stay.", ok: "Remove", danger: true })) return;
  try { dsSetStatus((await conn.call("deepseek.removeKey")).deepseek); toast("Key removed"); } catch (e) { return toast(e.message); }
  openSettingsRefresh();
}
/** Paste a key. The server checks it with DeepSeek; the field is cleared after use and the key is never shown. */
function keySheet() {
  const b = sheet.open(`<h2>DeepSeek API key</h2><div class="sub">From platform.deepseek.com → API keys.</div>
    <input class="field" id="ds-key-in" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-…" aria-label="DeepSeek API key">
    <p class="ds-err" id="ds-key-err" role="alert" hidden></p>
    <div class="btns row2"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="save">Save</button></div>`,
  { key: "ds-key", onClose: () => { inp.value = ""; } });
  const inp = b.querySelector("#ds-key-in"), err = b.querySelector("#ds-key-err"), save = b.querySelector('[data-a="save"]');
  setTimeout(() => inp.focus(), 250);
  const done = () => { inp.value = ""; sheet.close(true); };
  b.querySelector('[data-a="cancel"]').onclick = done;
  const go = async () => {
    const key = inp.value.trim();
    if (!key || save.disabled) return;
    save.disabled = true; save.textContent = "Checking…"; err.hidden = true;
    try {
      const d = (await conn.call("deepseek.setKey", { key })).deepseek;
      done(); dsSetStatus(d);
      toast(d?.note || "DeepSeek is ready" + (d?.balance?.total != null ? " · " + dsBalanceText(d) : ""), 4000);
      if (page.isOpen) openSettingsRefresh();
    } catch (e) {
      if (e.code === "BAD_KEY") inp.value = "";
      err.textContent = e.code === "BAD_KEY" ? "DeepSeek didn't accept that key." : e.message;
      err.hidden = false; save.disabled = false; save.textContent = "Save";
    }
  };
  save.onclick = go;
  inp.onkeydown = e => { if (e.key === "Enter") go(); };
}

// ───────────── Usage sheet: the DeepSeek section ─────────────
/** Balance (DeepSeek's own number), spend today and this month (our estimate), this chat, and the price now. */
function dsUsageHtml(cur) {
  const d = state.deepseek || {}, b = d.balance, sp = d.spend || {}, cap = sp.cap || 0;
  const thisChat = cur && !cur.isNew && chatEngine(cur.sessionId) === "deepseek";
  const chatUsd = thisChat ? (state.liveInfo[cur.sessionId]?.spend ?? state.sessions.find(s => s.sessionId === cur.sessionId)?.spend ?? 0) : null;
  const stale = !b?.at || Date.now() - b.at > 15 * 60e3;
  const balance = b?.available === false ? `<span class="ds-out">Out of credit</span> <small>Top up at platform.deepseek.com</small>`
    : b?.total != null ? `<b>${esc(dsMoney(b.total, b.currency))}</b> left`
    : `<button class="ds-tap" id="ds-u-refresh">${esc(d.balanceError ? "Couldn't check" : "Unknown")} · tap to refresh</button>`;
  const pct = cap ? Math.min(100, Math.round((sp.today || 0) / cap * 100)) : 0;
  const spent = `${dsMoney(sp.today || 0)}${cap ? " of " + dsCap(cap) : ""} today · ${dsMoney(sp.month || 0)} this month`;
  const level = pct >= 100 ? "full" : pct >= 90 ? "warn" : "";
  const price = dsPriceLine(d.price);
  return `<div class="u-ds"><h3 class="u-sec">DeepSeek</h3>`
    + `<div class="ds-bal${stale ? " stale" : ""}"><span class="ds-fig">${balance}</span> ${b?.at && b.available !== false && b.total != null ? `<small>from DeepSeek · ${esc(dsAgo(b.at))}</small>` : ""}</div>`
    + `<div class="ds-row ${level}"><span>Spent</span> <small>${esc(spent)}</small></div>`
    + (cap ? `<span class="u-bar ds-bar ${level}" role="meter" aria-label="DeepSeek spend today" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${(sp.today || 0).toFixed(3)}" aria-valuetext="${esc(spent)}"><i style="width:${pct}%"></i></span>` : "")
    + (thisChat ? `<div class="ds-row"><span>This chat</span> <small>${esc(dsMoney(chatUsd || 0))}</small></div>` : "")
    + (price ? `<p class="ds-price ${d.price.peak ? "peak" : "off"}"><i aria-hidden="true"></i><span>${esc(price)}</span></p>` : "")
    + `<p class="u-foot">Spend is estimated from token counts at DeepSeek's prices${sp.searchesToday ? ` · ${sp.searchesToday} web search${sp.searchesToday === 1 ? "" : "es"} today, billed separately` : ""}.</p></div>`;
}
function wireDsUsage(root, reload) { const t = root.querySelector("#ds-u-refresh"); if (t) t.onclick = () => reload(); }

// ───────────── linked chats: workers and the chat that started them ─────────────
const parentOf = p => (typeof p === "string" ? p : p?.parent) || null;
/** Every known link, from `link` events, the chat list and live chats: child id -> { parent, engine, title, toolUseId, at,
 *  runAt, result, steps, ms, usd, endedAt } (the outcome fields describe the worker's latest run, once it ended). */
function dsLinks() {
  const out = {};
  const add = (id, l) => { if (id && (l.parent || out[id])) out[id] = { ...out[id], ...Object.fromEntries(Object.entries(l).filter(([, v]) => v != null && v !== "")) }; };
  for (const s of state.sessions) if (s.parent) add(s.sessionId, { ...(s.worker || {}), parent: parentOf(s.parent), engine: s.engine || "claude", title: s.title || s.firstPrompt });
  for (const [id, i] of Object.entries(state.liveInfo)) if (i.parent) add(id, { parent: parentOf(i.parent), engine: i.engine || "claude" });
  for (const [id, l] of Object.entries(state.links)) add(id, l);
  return out;
}
/** The chat that started this worker chat, or null. */
const workerParentOf = id => state.liveInfo[id]?.parent || state.links[id]?.parent || parentOf(state.sessions.find(s => s.sessionId === id)?.parent) || null;
function dsChatTitle(id) {
  const s = state.sessions.find(x => x.sessionId === id);
  return state.links[id]?.title || s?.title || s?.firstPrompt || state.liveInfo[id]?.title || "";
}
/** "needs you" | "working" | "starting" | "done" | "stopped" | "failed" */
function dsLinkState(id, l = dsLinks()[id]) {
  const st = sessionState(id);
  if (st === "waiting") return "needs you";
  if (st === "running") return "working";
  if (st === "starting") return "starting";
  if (l?.result === "stopped" || l?.result === "failed") return l.result;
  // a run that began and never ended, with the worker gone: starting while its caller waits on it, else cut off
  if (!l?.result && l?.runAt && !l.endedAt && !state.liveInfo[id]) return sessionState(l.parent) === "running" ? "starting" : "stopped";
  return "done";
}
const LINK_RANK = { "needs you": 0, working: 1, starting: 2, done: 3, stopped: 3, failed: 3 };
function dsKids(parent, links = dsLinks()) {
  return Object.entries(links).filter(([, l]) => l.parent === parent)
    .sort(([a, x], [b, y]) => LINK_RANK[dsLinkState(a, x)] - LINK_RANK[dsLinkState(b, y)] || (y.runAt || y.at || 0) - (x.runAt || x.at || 0));
}
// main.js's handlers update the state first (they're registered later), so draw after them
const dsSoon = debounce(() => { dsRefreshHandoffs(); if (typeof agentsChanged === "function") agentsChanged(); }, 60);
for (const t of ["state", "permission.request", "permission.resolved", "sessions.changed", "activity", "tasks"]) conn.on(t, dsSoon);
// a worker starts (or gets a follow-up), then the same event again with how the run went
conn.on("link", m => {
  const run = "result" in m ? { result: m.result, steps: m.steps, ms: m.ms, usd: m.usd, endedAt: m.endedAt } : { runAt: Date.now(), result: null, steps: null, ms: null, usd: null, endedAt: null };
  state.links[m.child] = { ...state.links[m.child], parent: m.parent, engine: m.engine, title: m.title, toolUseId: m.toolUseId, at: state.links[m.child]?.at || Date.now(), ...run };
  // the worker's own state events follow once it has its task; until then it's starting
  if (!("result" in m) && !state.liveInfo[m.child]) state.liveInfo[m.child] = { sessionId: m.child, state: "starting", parent: m.parent, engine: m.engine, title: m.title };
  dsSoon();
});
conn.on("deepseek", m => { if (m.deepseek) dsSetStatus(m.deepseek); });

// ───────────── the approval sheet for a worker ─────────────
/** What the worker may do without asking: the calling chat's mode, unless Settings names one; a DeepSeek worker of an
 *  Auto chat gets Auto-edit, since DeepSeek chats have no Auto mode (server/src/delegate.js, workerMode()). */
function dsWorkerMode(parent, ds) {
  const m = state.deepseek?.settings?.workerMode || parent.permissionMode || "default";
  return (MODES.find(x => x.id === (ds && m === "auto" ? "acceptEdits" : m)) || MODES[0]).short;
}
/** "Send this to DeepSeek?" / "Ask Claude?": where and how it runs, and the whole task. No shortcut on the notification.
 *  It asks the first time (never in Bypass: the server lets those through); "don't ask again" lasts until the chat closes. */
function delegationSheet(p) {
  const inp = p.input || {}, ds = p.toolName === DS_TOOL, parent = state.liveInfo[p.sessionId] || {};
  const folder = shortPath(inp.cwd || parent.cwd || state.current?.cwd || ""), mode = dsWorkerMode(parent, ds);
  const sp = state.deepseek?.spend, title = inp.title && inp.title !== dsFirstLine(inp.task) ? inp.title : "";
  let line = inp.continue_chat ? `Follow-up to ${dsChatTitle(inp.continue_chat) || "a worker chat"} · ${mode}`
    : ds ? ["New DeepSeek chat", folder, dsShortModel(inp.model === "pro" ? "deepseek-v4-pro" : inp.model === "flash" ? "deepseek-flash" : dsDefaultModel()), mode].join(" · ")
    : ["New Claude chat", folder, (inp.model || "opus")[0].toUpperCase() + (inp.model || "opus").slice(1), mode, "uses your Claude plan"].join(" · ");
  if (ds && sp) line += ` · today ${dsMoney(sp.today || 0)}${sp.cap ? " of " + dsCap(sp.cap) : ""}`;
  const b = sheet.open(`<h2>${ds ? "Send this to DeepSeek?" : "Ask Claude?"}</h2><div class="sub" id="dl-line"></div>
    ${title ? `<div class="dl-title" id="dl-title"></div>` : ""}<div class="perm-detail md dl-task" id="dl-task"></div>
    <div class="btns"><button class="btn primary" data-a="allow">${ds ? "Send to DeepSeek" : "Ask Claude"}</button>
    <button class="btn" data-a="always">${ds ? "Send" : "Ask"}, and don't ask again in this chat</button>
    <div class="btns row2" style="margin-top:0"><button class="btn danger" data-a="deny">Deny</button><button class="btn ghost" data-a="tell">Deny & say why</button></div></div>`,
  { key: "perm:" + p.requestId });
  b.querySelector("#dl-line").textContent = line;
  if (title) b.querySelector("#dl-title").textContent = title;
  setMd(b.querySelector("#dl-task"), inp.task || "");
  const reply = async (behavior, extra = {}) => {
    haptic("tick"); sheet.close(true);
    const card = chat.tools.get(p.toolUseID);
    if (card && behavior === "deny") card.denied = true;   // its line says "Not sent", whatever words come back
    try { await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior, ...extra }); } catch (e) { toast(e.message); }
  };
  b.querySelector('[data-a="allow"]').onclick = () => reply("allow");
  b.querySelector('[data-a="always"]').onclick = () => reply("allow", { always: true });
  b.querySelector('[data-a="deny"]').onclick = () => reply("deny");
  b.querySelector('[data-a="tell"]').onclick = async () => {
    const why = await promptSheet({ title: `What should ${ENGINE_NAME[chatEngine(p.sessionId)]} do instead?`, multiline: true, ok: "Send" });
    if (why) reply("deny", { message: why }); else showNextPermission();
  };
}

// ───────────── the quiet handoff line in the calling chat ─────────────
/** The report's stable format (server/src/delegate.js): status line, Chat:, Title:, Folder:, Model:, Changed:, ---, text. */
function dsParseReport(text) {
  const t = String(text || ""), r = { chat: (/^Chat: ([0-9a-f-]{36})$/m.exec(t) || [])[1] || null };
  const m = /^(?:DeepSeek|Claude) worker: (done|stopped|failed)/.exec(t);
  if (!m) return { ...r, raw: t };
  r.status = m[1];
  const head = t.split(/^---$/m)[0];
  r.model = (/^Model: (.*)$/m.exec(head) || [])[1] || "";
  // "deepseek-flash · 3m 12s · about $0.031" (or "1h 02m", "12s"; Claude workers have no cost): the run's time and cost
  const [, dur = "", cost = ""] = r.model.split(" · "), n = re => +(re.exec(dur)?.[1] || 0);
  if (/^\d+[hms]/.test(dur)) r.ms = (n(/(\d+)h/) * 3600 + n(/(\d+)m/) * 60 + n(/(\d+)s/)) * 1000;
  if (/^about \$[\d.]+$/.test(cost)) r.usd = +cost.slice(7); else if (/^under \$/.test(cost)) r.usd = 0.0005;
  r.changed = (/^Changed: (.*)$/m.exec(head) || [])[1] || "";
  r.files = (/^Changed: .*\n((?: {2}.*\n?)*)/m.exec(head) || [])[1]?.split("\n").map(s => s.trim()).filter(Boolean) || [];
  const cut = t.search(/^---$/m);
  r.body = cut >= 0 ? t.slice(cut + 4).trim() : "";
  return r;
}
/** The worker chat of a handoff: from its report, or from the `link` event that named its tool call. */
function dsChildOf(card) {
  if (card.report?.chat) return card.report.chat;
  return Object.entries(dsLinks()).find(([, l]) => l.toolUseId === card.id)?.[0] || null;
}
/** What a handoff line says, e.g. { lead: "Sent to DeepSeek", title: "Add README", status: "done", tone: "" }. */
function handoffState(card) {
  const inp = card.input || {}, ds = card.name === DS_TOOL, follow = !!inp.continue_chat, r = card.report;
  const title = (follow && dsChatTitle(inp.continue_chat)) || inp.title || dsFirstLine(inp.task) || card.streamTitle || (follow ? "a worker" : "");
  const lead = (kind) => ({
    asking: follow ? `Follow-up to ${ds ? "DeepSeek" : "Claude"}` : ds ? "Sending to DeepSeek" : "Asking Claude",
    sent: follow ? `Follow-up to ${ds ? "DeepSeek" : "Claude"}` : ds ? "Sent to DeepSeek" : "Asked Claude",
    denied: follow ? `Follow-up not sent to ${ds ? "DeepSeek" : "Claude"}` : ds ? "Not sent to DeepSeek" : "Didn't ask Claude",
    failed: follow ? `Couldn't send the follow-up to ${ds ? "DeepSeek" : "Claude"}` : ds ? "Couldn't send to DeepSeek" : "Couldn't ask Claude",
  })[kind];
  if (r?.status) return { lead: lead("sent"), title, status: r.status, tone: r.status === "done" ? "" : "bad" };
  if (r) return card.denied || /denied|rejected|doesn't want|did not want|not want to proceed/i.test(r.raw) ? { lead: lead("denied"), title, status: "", tone: "" } : { lead: lead("failed"), title, status: "", tone: "bad" };
  if (state.pending.some(p => p.toolUseID === card.id)) return { lead: lead("asking"), title, status: "needs your OK", tone: "needs" };
  const child = card.child;
  if (child) {
    const st = dsLinkState(child);
    // the worker finished, its report is on the way
    return { lead: lead("sent"), title, status: st === "done" && card.status === "run" ? "finishing" : st, tone: st === "needs you" ? "needs" : st === "stopped" || st === "failed" ? "bad" : "", busy: st === "working" || st === "starting" || card.status === "run" && st === "done" };
  }
  if (card.status === "run") return { lead: lead("sent"), title, status: "starting", tone: "", busy: true };
  return { lead: lead("sent"), title, status: "", tone: "" };   // cut off before it reported (an older chat)
}
/** render.js calls this for deepseek_task / claude_task: the line's words, and how it ended once the result is in. */
function handoffLine(card, text, isErr) {
  if (text !== undefined) { card.report = dsParseReport(text); card.isErr = !!isErr; }
  card.child = dsChildOf(card) || card.child || null;
  if (card.child && card.report?.status) state.links[card.child] = { ...state.links[card.child], result: card.report.status };
  const st = handoffState(card), el = card.el;
  el.classList.toggle("working", !!st.busy);
  el.querySelector(".sl-t").textContent = st.title ? `${st.lead}: ${st.title}` : st.lead;
  const s = el.querySelector(".hl-st");
  s.textContent = st.status ? "\u00a0· " + st.status : "";   // a flex item drops a plain leading space
  s.className = "hl-st" + (st.tone ? " " + st.tone : "");
}
function dsRefreshHandoffs() { for (const c of chat.tools.values()) if (c.handoff) handoffLine(c); }
