// Usage limits: a meter in the chats drawer, a note above the message box from 90%, and a details sheet.
// The server keeps the numbers current from every reply (server/src/usage.js).
const USAGE_LABEL = { five_hour: "5-hour", seven_day: "Week", seven_day_opus: "Week · Opus", seven_day_sonnet: "Week · Sonnet" };
const USAGE_NAME = { five_hour: "5-hour limit", seven_day: "weekly limit" };

/** A window as it stands now: one whose reset time has passed starts over at 0. */
function usageWindow(w) {
  if (!w || w.used == null) return null;
  const past = w.resetsAt && w.resetsAt <= Date.now();
  const used = past ? 0 : Math.max(0, Math.min(100, w.used)), status = past ? "allowed" : w.status;
  return { used, resetsAt: past ? null : w.resetsAt, level: status === "rejected" || used >= 100 ? "full" : status === "allowed_warning" || used >= 90 ? "warn" : "" };
}
function usageResets(ms) {
  if (!ms) return "";
  const d = ms - Date.now();
  if (d <= 0) return "";
  if (d < 3600e3) return `resets in ${Math.max(1, Math.floor(d / 60e3))}m`;
  if (d < 86400e3) return `resets in ${Math.floor(d / 3600e3)}h ${Math.floor(d % 3600e3 / 60e3)}m`;
  return "resets " + new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
/** [label, window] pairs: the two main limits, or every known one for the details. */
function usageRows(all) {
  const u = state.usage, rows = [];
  for (const k of all ? Object.keys(USAGE_LABEL) : ["five_hour", "seven_day"]) { const w = usageWindow(u?.windows?.[k]); if (w) rows.push([USAGE_LABEL[k], w]); }
  if (all) for (const m of u?.models || []) { const w = usageWindow(m); if (w) rows.push(["Week · " + m.name, w]); }
  return rows;
}
const usageRow = ([label, w], big) => `<div class="u-row ${w.level}${big ? " big" : ""}"><div class="u-top"><span>${esc(label)}</span>`
  + `<small>${w.used}%${usageResets(w.resetsAt) ? " · " + usageResets(w.resetsAt) : ""}</small></div><span class="u-bar"><i style="width:${w.used}%"></i></span></div>`;
function usageSummary() {
  const rows = usageRows(false);
  return rows.length ? rows.map(([l, w]) => `${l} ${w.used}%`).join(" · ") : "Shows after your next message";
}

function renderUsage() {
  const rows = usageRows(false), meter = $("#usage-meter");
  meter.hidden = !rows.length;
  meter.innerHTML = rows.map(r => usageRow(r)).join("");
  renderUsageRing();
  // the note above the message box: the closest limit from 90%, or the one that's been reached
  const u = state.usage, worst = ["five_hour", "seven_day"].map(k => [k, usageWindow(u?.windows?.[k])]).filter(([, w]) => w?.level)
    .sort((a, b) => b[1].used - a[1].used)[0];
  const blocked = u?.status === "rejected" && u.resetsAt > Date.now();
  const note = $("#usage-note");
  if (!worst && !blocked) { note.hidden = true; return; }
  const [k, w] = worst || [u.limit, { level: "full", resetsAt: u.resetsAt }];
  const name = USAGE_NAME[k] || "usage limit", when = usageResets(w.resetsAt);
  note.hidden = false;
  note.className = w.level;
  note.innerHTML = `${icon("info")}<span>${w.level === "full" ? `${name[0].toUpperCase() + name.slice(1)} reached` : `${w.used}% of your ${name} used`}${when ? " · " + when : ""}</span>`;
}

const USAGE_SPAN = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 };
/** "At this pace…": when the steady rate since the window began would reach 100%, if that's before the reset. */
function usagePace() {
  for (const k of ["five_hour", "seven_day"]) {
    const w = usageWindow(state.usage?.windows?.[k]);
    if (!w?.resetsAt || w.used < 20 || w.used >= 100) continue;
    const start = w.resetsAt - USAGE_SPAN[k], gone = Date.now() - start;
    if (gone < 15 * 60e3) continue;
    const out = Date.now() + (100 - w.used) / (w.used / gone);
    if (out >= w.resetsAt) continue;
    const day = d => new Date(d).toDateString() === new Date().toDateString() ? "" : new Date(d).toLocaleDateString([], { weekday: "short" }) + " ";
    const at = d => day(d) + new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `At this pace you'll run out of your ${USAGE_NAME[k]} around ${at(out)}, before it resets ${at(w.resetsAt)}.`;
  }
  return "";
}

/** The ring in the chat header: the fuller of the 5-hour and weekly limits. */
function renderUsageRing() {
  const btn = $("#btn-usage"), rows = usageRows(false);
  if (!btn) return;
  btn.hidden = !rows.length;
  if (!rows.length) return;
  const [label, w] = rows.slice().sort((a, b) => b[1].used - a[1].used)[0];
  const c = 2 * Math.PI * 8;
  btn.className = "icon-btn usage-ring " + w.level;
  btn.setAttribute("aria-label", `Usage: ${label} limit ${w.used}% used`);
  btn.innerHTML = `<svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="8" class="track"/><circle cx="11" cy="11" r="8" class="fill" stroke-dasharray="${(c * w.used / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 11 11)"/></svg>`;
}

/** One sheet for everything that runs out: this chat's context window and the account's limits. */
async function openUsage() {
  const cur = state.current, saved = cur && !cur.isNew && cur.sessionId;
  let ctx = null, busy = true, open = false;
  const draw = () => {
    if (sheet.key !== "usage") return;
    const b = $("#usage-sheet"), u = state.usage, rows = usageRows(true), plan = u?.plan || state.account?.subscriptionType, pace = usagePace();
    const cats = (ctx?.categories || []).filter(c => c.tokens > 0);
    b.innerHTML = `<div class="u-head"><h2>Usage</h2><button class="icon-btn" id="u-refresh" aria-label="Refresh">${icon("retry")}</button></div>`
      + `<div class="sub">${esc([plan && "Claude " + plan[0].toUpperCase() + plan.slice(1), busy ? "Updating…" : u?.at ? "Updated " + (relTime(u.at) === "now" ? "just now" : relTime(u.at) + " ago") : ""].filter(Boolean).join(" · "))}</div>`
      + (ctx ? `<h3 class="u-sec">This chat</h3><button class="u-ctx${open ? " open" : ""}" id="u-ctx" aria-expanded="${open}">`
        + usageRow(["Context window", { used: Math.round(ctx.percentage), level: ctx.percentage >= 90 ? "warn" : "", resetsAt: null }], true).replace("</small>", ` ${icon("down")}</small>`)
        + `<span class="u-sub">${fmtTok(ctx.totalTokens)} of ${fmtTok(ctx.maxTokens)} tokens${ctx.estimated ? " · from the last reply" : ""}</span></button>`
        + (open ? `<div class="u-cats">${cats.map(c => `<div class="ctx-row"><span><i style="background:${esc(c.color)}"></i>${esc(c.name)}</span><span>${fmtTok(c.tokens)}</span></div>`).join("")}<button class="chip" id="u-compact">Compact this chat now</button></div>` : "") : "")
      + (pace ? `<p class="u-pace">${icon("info")}<span>Heads up. ${esc(pace)}</span></p>` : "")
      + `<h3 class="u-sec">Plan limits</h3>`
      + (rows.length ? `<div class="u-list">${rows.map(r => usageRow(r, true)).join("")}</div>` : `<p class="u-foot">Nothing yet: the numbers come with Claude's replies. Send a message, then look again.</p>`)
      + `<p class="u-foot">Limits count everything on this Claude account: this phone, your computers and claude.ai.</p>`;
    hydrateIcons(b);
    b.querySelector("#u-refresh").onclick = () => load(true);
    const t = b.querySelector("#u-ctx"); if (t) t.onclick = () => { open = !open; draw(); };
    const k = b.querySelector("#u-compact"); if (k) k.onclick = () => { sheet.close(true); send("/compact"); };
  };
  const load = async refresh => {
    busy = true; draw();
    await Promise.all([
      conn.call("usage.get", { refresh }).then(r => { if (r.usage) { state.usage = r.usage; renderUsage(); } }).catch(() => {}),
      saved ? conn.call("session.context", { sessionId: cur.sessionId }).then(r => { ctx = r.usage; }).catch(() => {}) : null,
    ]);
    busy = false; draw();
  };
  sheet.open(`<div id="usage-sheet"></div>`, { key: "usage" });
  load(true);
}
$("#usage-meter").onclick = () => openUsage();
$("#usage-note").onclick = () => openUsage();
$("#btn-usage").onclick = () => openUsage();
setInterval(() => { if (state.usage) renderUsage(); }, 60000);
