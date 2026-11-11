// activity.js — the live "what is Claude doing" bar above the composer, and the step log.
// The server derives the activity (server/src/activity.js); this file only renders it.
"use strict";

state.activity = {};   // sessionId -> activity snapshot from the server

const PHASE_ICON = { sending: "up", starting: "bolt", waiting: "bolt", thinking: "brain", writing: "pencil", tool: "terminal",
  approval: "key", subagent: "bot", retrying: "retry", compacting: "list", idle: "check", error: "x" };
const BUSY_PHASES = new Set(["sending", "starting", "waiting", "thinking", "writing", "tool", "subagent", "retrying", "compacting"]);
let activityTick = null;

function currentActivity() { const id = state.current?.sessionId; return id ? state.activity[id] : null; }
function elapsed(a) { return a?.turnStart ? fmtDur(Math.floor((Date.now() - a.turnStart) / 1000) * 1000) : ""; }

/** Show the bar while a turn runs, for errors, and briefly after a turn finishes. */
function renderActivity() {
  const bar = $("#activity");
  const a = currentActivity();
  const st = sessionState(state.current?.sessionId);
  const running = st === "running" || st === "waiting";
  const recentEnd = a && (a.phase === "idle" || a.phase === "error") && a.turnStart && Date.now() - a.since < (a.phase === "error" ? 60000 : 6000);
  if (!a || (!running && !recentEnd)) { bar.hidden = true; stopActivityTick(); if (sheet.key === "activity") renderActivityLog(); return; }
  // If the server hasn't reported yet but the session is running, show a generic state.
  const phase = running && !BUSY_PHASES.has(a.phase) && a.phase !== "approval" ? "waiting" : a.phase;
  const busy = BUSY_PHASES.has(phase);
  const done = a.steps.filter(s => s.kind === "tool" && s.status !== "run").length;
  const tok = a.tokens?.thinking ? ` · ${fmtTok(a.tokens.thinking)} thinking` : "";
  bar.hidden = false;
  bar.className = "activity " + phase;
  bar.innerHTML = `<span class="a-ic">${busy ? '<span class="spark"></span>' : icon(PHASE_ICON[phase] || "info")}</span>
    <div class="a-main"><div class="a-top"><b></b><span class="a-meta"></span></div><div class="a-detail"></div></div>
    <span class="a-steps">${a.steps.length ? `${done}/${a.steps.filter(s => s.kind === "tool").length || a.steps.length}` : ""}${icon("list")}</span>`;
  bar.querySelector("b").textContent = phase === "waiting" && running && a.phase !== "waiting" ? "Working" : a.label;
  bar.querySelector(".a-meta").textContent = `${elapsed(a)}${tok}`;
  bar.querySelector(".a-detail").textContent = a.detail || (phase === "approval" ? "Tap to review" : "");
  bar.onclick = () => phase === "approval" ? showNextPermission() : openActivityLog();
  if (busy || phase === "approval") startActivityTick(); else stopActivityTick();
  if (sheet.key === "activity") renderActivityLog();
}
function startActivityTick() {
  if (activityTick) return;
  activityTick = setInterval(() => {
    const a = currentActivity();
    const m = $("#activity .a-meta");
    if (m && a) m.textContent = `${elapsed(a)}${a.tokens?.thinking ? ` · ${fmtTok(a.tokens.thinking)} thinking` : ""}`;
    if (a && (a.phase === "idle" || a.phase === "error")) renderActivity();
  }, 1000);
}
function stopActivityTick() { clearInterval(activityTick); activityTick = null; }

/** Full step-by-step log of the current turn; updates live while open. */
function openActivityLog() {
  sheet.open(`<div id="act-log"></div>`, { key: "activity" });
  renderActivityLog();
}
function renderActivityLog() {
  const box = $("#act-log"); if (!box) return;
  const a = currentActivity();
  if (!a) { box.innerHTML = `<h2>No activity yet</h2>`; return; }
  const t0 = a.turnStart || (a.steps[0]?.at ?? Date.now());
  const rel = ms => "+" + fmtDur(Math.max(0, Math.floor((ms - t0) / 1000)) * 1000);
  const statusIcon = s => s.status === "run" ? '<span class="spark"></span>' : icon(s.status === "ok" ? "check" : "x");
  const kindIcon = s => icon(s.kind === "subagent" ? "bot" : s.kind === "note" ? "info" : (TOOL_ICON[s.tool] || "terminal"));
  box.innerHTML = `<h2>${esc(a.label)}</h2>
    <div class="sub">${esc(a.detail || "")}</div>
    <div class="act-stats"><span>${icon("bolt")}${esc(elapsed(a) || "–")}</span><span>${icon("brain")}${fmtTok(a.tokens?.thinking || 0)} thinking</span><span>${icon("pencil")}${fmtTok(a.tokens?.output || 0)} written</span><span>${icon("list")}${a.steps.length} steps</span></div>
    <div class="act-steps">${a.steps.length ? a.steps.map(s => `
      <div class="act-step ${s.status} ${s.parent ? "nested" : ""}">
        <span class="as-k">${kindIcon(s)}</span>
        <div class="as-m"><div class="as-t">${esc(s.title)}</div>${s.detail ? `<div class="as-d">${esc(s.detail)}</div>` : ""}</div>
        <span class="as-time">${rel(s.at)}${s.end ? ` · ${fmtDur(s.end - s.at)}` : ""}</span>
        <span class="as-s">${statusIcon(s)}</span>
      </div>`).join("") : `<div class="sub">No tool calls yet. Claude is ${esc(a.label.toLowerCase())}.</div>`}</div>
    ${sessionState(state.current?.sessionId) === "running" ? `<div class="btns"><button class="btn danger" id="act-stop">Stop Claude</button></div>` : ""}`;
  $("#act-stop")?.addEventListener("click", () => { sheet.close(true); interrupt(); });
  const list = box.querySelector(".act-steps"); list.scrollTop = list.scrollHeight;
}
