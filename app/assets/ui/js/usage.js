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

async function openUsage() {
  const draw = (b, busy) => {
    const rows = usageRows(true), u = state.usage, plan = u?.plan || state.account?.subscriptionType;
    b.innerHTML = `<h2>Usage limits</h2><div class="sub">${esc([plan && "Claude " + plan[0].toUpperCase() + plan.slice(1), busy ? "Updating…" : u?.at ? "Updated " + (relTime(u.at) === "now" ? "just now" : relTime(u.at) + " ago") : ""].filter(Boolean).join(" · "))}</div>`
      + (rows.length ? `<div class="u-list">${rows.map(r => usageRow(r, true)).join("")}</div>` : `<p class="u-foot">Nothing yet: the numbers come with Claude's replies. Send a message, then look again.</p>`)
      + `<p class="u-foot">Counts everything on this Claude account: this phone, your computers and claude.ai.</p>`;
  };
  const b = sheet.open(`<div id="usage-sheet"></div>`, { key: "usage" }).firstElementChild;
  draw(b, true);
  try { const r = await conn.call("usage.get", { refresh: true }); if (r.usage) { state.usage = r.usage; renderUsage(); } } catch {}
  if (sheet.key === "usage") draw(b, false);
}
$("#usage-meter").onclick = () => openUsage();
$("#usage-note").onclick = () => openUsage();
setInterval(() => { if (state.usage) renderUsage(); }, 60000);
