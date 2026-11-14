// agents.js — everything a chat started, in one place (#52): the slim Chat · Agents switch under the header, the
// Agents tab (DeepSeek and Claude workers, Claude's own subagents and background commands), an agent's page (its live
// conversation, Stop, Open as chat), and the way in from a quiet handoff line in the chat.
// Workers are chats of their own, linked to the chat that started them (deepseek.js keeps the links); subagents and
// commands come from the server's task list (info.tasks) and, once the chat has closed, from its subagent tool calls.
"use strict";

state.tab = "chat";   // the open chat's tab: "chat" | "agents"
const AG_ACTIVE = new Set(["needs you", "working", "starting"]);
const AG_RANK = { "needs you": 0, working: 1, starting: 2 };
const TASK_STATE = { running: "working", completed: "done", stopped: "stopped", killed: "stopped", failed: "failed" };
const AG_STATUS = { "needs you": "Needs you", working: "Working", starting: "Starting", done: "Done", stopped: "Stopped", failed: "Failed" };
let agentPage = null;   // the agent page on screen: { key, kind, id, … }

// ───────────── what this chat started ─────────────
/** Every agent of a chat, working ones first: { key, kind: worker|agent|command, engine, title, status, now, steps, usd, tokens, ms, at, … }. */
function chatAgents(sid = state.current?.sessionId) {
  const cur = state.current;
  if (!sid || (cur?.sessionId === sid && cur.isNew)) return [];
  const out = [], seen = new Set();
  const links = dsLinks();
  for (const [id, l] of dsKids(sid, links)) { out.push(workerAgent(id, l)); if (l.toolUseId) seen.add(l.toolUseId); }
  const tasks = state.liveInfo[sid]?.tasks || [];
  for (const t of tasks) {
    if (t.toolUseId && seen.has(t.toolUseId)) continue;   // a handoff Claude Code tracks as a task too: it's the worker above
    out.push(taskAgent(t, sid));
    if (t.toolUseId) seen.add(t.toolUseId);
  }
  // a closed chat has no task list: its subagents come from the chat itself
  if (sid === cur?.sessionId) {
    const named = new Set(tasks.filter(t => !t.toolUseId).map(t => t.description));
    const cards = [...chat.tools.values()].filter(c => (c.name === "Task" || c.name === "Agent") && !seen.has(c.id) && !c.el.closest(".subagent") && !named.has(c.input?.description));
    cards.forEach((c, i) => out.push(cardAgent(c, i - cards.length)));
  }
  return out.sort((a, b) => (AG_RANK[a.status] ?? 9) - (AG_RANK[b.status] ?? 9) || b.at - a.at);
}
function workerAgent(id, l) {
  const status = dsLinkState(id, l), live = state.liveInfo[id], act = live ? state.activity[id] || live.activity : null;
  const engine = l.engine === "deepseek" ? "deepseek" : "claude", busy = AG_ACTIVE.has(status);
  const card = [...chat.tools.values()].filter(c => c.handoff && c.child === id).pop();
  const pend = state.pending.find(p => p.sessionId === id);
  const now = status === "needs you" ? (pend ? sentence(askPhrase(pend.toolName, pend.input)) : "Waiting for you")
    : busy ? actNow(act) : status === "done" ? doneNote(card?.report) : "";
  const fromAct = act?.turnStart && (busy || act.phase === "idle" || act.phase === "error");
  return { key: "w:" + id, kind: "worker", id, engine, title: dsChatTitle(id) || "Worker", status, now, parent: l.parent,
    steps: fromAct ? act.steps.filter(s => s.kind === "tool").length : l.steps ?? null,
    usd: engine === "deepseek" ? live?.spend ?? state.sessions.find(s => s.sessionId === id)?.spend ?? l.usd ?? card?.report?.usd ?? null : null,
    tokens: engine === "claude" && fromAct ? act.tokens?.output || null : null,
    ms: busy && act?.turnStart ? Date.now() - act.turnStart : l.ms ?? card?.report?.ms ?? (fromAct ? act.since - act.turnStart : null),
    at: l.runAt || l.at || 0, allowAll: !!live?.allowAll, report: card?.report || null };
}
function taskAgent(t, sid) {
  const status = TASK_STATE[t.status] || "done";
  return { key: "t:" + t.id, kind: t.kind === "agent" ? "agent" : "command", id: t.id, sid, engine: chatEngine(sid), title: t.description || "Background task", status,
    now: status === "working" ? t.activity || (t.kind === "agent" ? "Starting…" : "") : t.summary && t.summary !== t.description ? t.summary : "",
    steps: t.tools ?? null, tokens: t.tokens ?? null, ms: status === "working" ? Date.now() - (t.startedAt || Date.now()) : t.ms || ((t.endedAt || Date.now()) - t.startedAt), at: t.startedAt || 0, agentType: t.agentType, toolUseId: t.toolUseId };
}
/** A subagent seen only in the chat's history: its tool call (prompt and result). */
function cardAgent(c, at) {
  return { key: "c:" + c.id, kind: "agent", card: c, engine: chatEngine(), title: c.input?.description || "Subagent", agentType: c.input?.subagent_type,
    status: c.status === "err" ? "failed" : c.status === "run" ? "working" : c.status === "unknown" ? "stopped" : "done", now: "", steps: null, tokens: null, ms: null, at };
}
const sentence = s => s ? s[0].toUpperCase() + s.slice(1) : "";
/** What a working agent is doing now, from its live activity: "Running a command: npm test". */
function actNow(a) {
  if (!a) return "Starting…";
  if (a.phase === "approval") return "Waiting for your approval";
  return a.detail && a.phase === "tool" ? `${a.label}: ${a.detail}` : a.label || "Working";
}
function doneNote(r) {
  if (!r?.changed || /^\(/.test(r.changed)) return "";
  return r.changed === "nothing" ? "No files changed" : r.changed + " changed";
}
/** "45s", "1m 12s" */
const agDur = ms => ms == null || ms < 1000 ? "" : ms < 60e3 ? Math.round(ms / 1000) + "s" : fmtDur(ms);
/** "DeepSeek · 3 steps · $0.004 · 1m 12s" — what it is, then whatever is known */
function agentMetaParts(a) {
  const kind = a.kind === "worker" ? ENGINE_NAME[a.engine] : a.kind === "command" ? "Command"
    : a.agentType && a.agentType !== "general-purpose" ? sentence(a.agentType) + " agent" : "Subagent";
  return [kind, a.steps ? `${a.steps} step${a.steps === 1 ? "" : "s"}` : "", a.usd != null && a.engine === "deepseek" && a.kind === "worker" ? dsMoney(a.usd) : a.tokens ? fmtTok(a.tokens) + " tokens" : "",
    agDur(a.ms)].filter(Boolean);
}
const agentMeta = a => agentMetaParts(a).join(" · ");
/** The same as HTML: each item stays on one line, so a long line wraps between them. */
const agentMetaHtml = (a, extra = []) => agentMetaParts(a).concat(extra).map(x => `<span>${esc(x)}</span>`).join(" · ");
function agentGlyph(a) {
  return AG_ACTIVE.has(a.status) && a.status !== "needs you" ? '<span class="spark"></span>' : a.status === "needs you" ? '<i class="ag-dot"></i>' : icon(a.status === "done" ? "check" : "x");
}
const agTone = st => st === "needs you" ? "needs" : st === "stopped" || st === "failed" ? "bad" : "";

/** What a worker's approval asks, in the words notifications use (server/src/activity.js, askPhrase). */
function askPhrase(name, input = {}) {
  const i = input || {}, base = p => String(p || "").replace(/\/+$/, "").split("/").pop();
  switch (name) {
    case "Bash": { const c = String(i.command || "").trim(); return c && !c.includes("\n") && c.length <= 40 ? `wants to run ${c}` : "wants to run a command"; }
    case "Edit": case "MultiEdit": return `wants to edit ${base(i.file_path) || "a file"}`;
    case "NotebookEdit": return `wants to edit ${base(i.notebook_path) || "a notebook"}`;
    case "Write": return `wants to write ${base(i.file_path) || "a file"}`;
    case "Read": return `wants to read ${base(i.file_path) || "a file"}`;
    case "WebFetch": { let host = ""; try { host = new URL(i.url).hostname; } catch {} return host ? `wants to open ${host}` : "wants to open a web page"; }
    case "WebSearch": return "wants to search the web";
    case "Glob": case "Grep": return "wants to search files";
    case "AskUserQuestion": return "has a question";
    case "ExitPlanMode": return "has a plan ready";
    default: return name.startsWith("mcp__") ? `wants to use ${name.split("__").slice(1).join(" ")}` : `wants to use ${name}`;
  }
}
/** The same, as HTML for a sheet's heading: the command or file in code. */
function askPhraseHtml(name, input = {}) {
  const t = askPhrase(name, input), m = /^(wants to (?:run|edit|write|read|open)) (.+)$/.exec(t);
  // a path may break after its slashes, not in the middle of a name
  return m && !/^a (command|file|notebook|web page)$/.test(m[2]) ? `${esc(m[1])} <code>${esc(m[2]).replace(/(?<=\S)\//g, "/<wbr>")}</code>` : esc(t);
}

// ───────────── the switch under the header ─────────────
/** Shows the switch when the chat has started agents: "Agents 2" counts the ones at work, a dot says one needs you. */
function renderTabs() {
  const nav = $("#chat-tabs");
  if (!nav) return;
  const agents = chatAgents(), show = agents.length > 0;
  if (!show && state.tab === "agents") setTab("chat");
  nav.hidden = !show;
  if (!show) return;
  const active = agents.filter(a => AG_ACTIVE.has(a.status)).length, needs = agents.filter(a => a.status === "needs you").length;
  const t = $("#tab-agents");
  t.querySelector(".ct").textContent = active ? String(active) : "";
  t.querySelector(".tdot").hidden = !needs;
  t.setAttribute("aria-label", ["Agents", active && `${active} at work`, needs && `${needs} need${needs === 1 ? "s" : ""} you`].filter(Boolean).join(", "));
  if (state.tab === "agents") renderAgentsView(agents);
}
function setTab(tab) {
  if (tab === state.tab) return;
  const chatEl = $("#chat");
  if (tab === "agents") { state.chatScroll = chatEl.scrollTop; state.chatPinned = pinned; }
  state.tab = tab;
  document.body.classList.toggle("tab-agents", tab === "agents");
  $("#tab-chat").setAttribute("aria-selected", String(tab === "chat"));
  $("#tab-agents").setAttribute("aria-selected", String(tab === "agents"));
  $("#agents-view").hidden = tab !== "agents";
  if (tab === "agents") { renderAgentsView(); $("#agents-view").scrollTop = 0; }
  else if (state.chatPinned !== false) scrollToBottom(true);
  else chatEl.scrollTop = state.chatScroll || 0;
}
$("#tab-chat").onclick = () => setTab("chat");
$("#tab-agents").onclick = () => setTab("agents");
/** A new chat on screen starts on its Chat tab. */
function agentsChatChanged() {
  if (state.backTo && state.current?.sessionId !== state.backTo.worker) state.backTo = null;
  if (state.tab !== "chat") { state.chatPinned = true; setTab("chat"); }
  renderTabs();
}

// Swiping between the tabs: a quick, mostly sideways swipe that didn't start on something that scrolls sideways.
(() => {
  let x0 = 0, y0 = 0, t0 = 0, on = false;
  const sideways = el => { for (; el && el !== document.body; el = el.parentElement) if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true; return false; };
  $("#main").addEventListener("touchstart", e => {
    on = !$("#chat-tabs").hidden && e.touches.length === 1 && !sheet.isOpen && !page.isOpen && !e.target.closest("#composer") && !sideways(e.target);
    if (on) ({ clientX: x0, clientY: y0 } = e.touches[0]), t0 = Date.now();
  }, { passive: true });
  $("#main").addEventListener("touchend", e => {
    if (!on) return;
    on = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 700 || Math.abs(dx) < 64 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    if (dx < 0 && state.tab === "chat") setTab("agents"); else if (dx > 0 && state.tab === "agents") setTab("chat");
  }, { passive: true });
})();

// ───────────── the Agents tab ─────────────
/** One row per agent, kept and updated in place (a row redrawn under a finger would swallow the tap). */
function renderAgentsView(agents = chatAgents()) {
  const list = $("#agents-view .ag-list");
  if (!list || state.tab !== "agents") return;
  const keep = new Map([...list.querySelectorAll(".ag-row")].map(r => [r.dataset.key, r]));
  list.querySelector(".ag-none")?.remove();
  agents.forEach((a, i) => {
    let row = keep.get(a.key);
    keep.delete(a.key);
    if (!row) {
      row = h(`<button class="ag-row"><span class="ag-tile"></span><span class="ag-t"><b class="ag-ti"></b><small class="ag-now"></small><small class="ag-meta"></small></span></button>`);
      row.dataset.key = a.key;
      row.onclick = () => { const x = chatAgents().find(y => y.key === row.dataset.key); if (x) openAgentPage(x); };
    }
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    fillAgentRow(row, a);
  });
  for (const r of keep.values()) r.remove();
  if (!agents.length) list.append(h(`<p class="ag-none">Nothing yet.</p>`));
}
function fillAgentRow(row, a) {
  const tile = row.querySelector(".ag-tile"), glyph = agentGlyph(a);
  tile.className = `ag-tile ${a.kind === "command" ? "" : a.engine} ${a.status.replace(" ", "-")}`;
  if (tile.dataset.g !== glyph) { tile.innerHTML = glyph; tile.dataset.g = glyph; }
  row.querySelector(".ag-ti").textContent = a.title;
  const now = row.querySelector(".ag-now");
  now.innerHTML = `<span class="ag-st ${agTone(a.status)}"></span>${a.now ? " · <span></span>" : ""}`;
  now.firstChild.textContent = AG_STATUS[a.status] || a.status;
  if (a.now) now.lastChild.textContent = a.now;
  const meta = row.querySelector(".ag-meta");
  meta.innerHTML = agentMetaHtml(a);
  meta.classList.toggle("ds", a.engine === "deepseek" && a.kind === "worker");
  row.setAttribute("aria-label", `${a.title}. ${AG_STATUS[a.status] || a.status}${a.now ? ". " + a.now : ""}. ${agentMeta(a)}`);
}

/** Everything that can change what the Agents tab, the switch or an open agent page show (deepseek.js calls this). */
function agentsChanged() {
  renderTabs();
  renderActivity();   // a worker waiting for you shows on the chat's activity bar
  if (agentPage?.head) agentPage.head();
}
setInterval(() => {   // working agents' times count up
  if ((state.tab === "agents" || agentPage) && !document.hidden && chatAgents().some(a => AG_ACTIVE.has(a.status))) agentsChanged();
}, 1000);

// ───────────── an agent's page ─────────────
function openAgentPage(a) {
  if (a.kind === "worker") return openWorkerPage(a.id);
  if (a.card) return openStep(a.card.el);   // a subagent of an earlier session: its call and result
  return openTaskPage(a);
}
/** The page's frame: a sticky head (state, Stop, Open as chat) over the conversation. The same element comes back
 *  when a step page on top of it closes, so the conversation keeps its place and keeps updating. */
function agentFrame(ctx, { openAsChat } = {}) {
  ctx.el = h(`<div class="ag-page"><div class="ag-head"><div class="ag-hst"></div><div class="ag-hrow"><small class="ag-hmeta"></small>
    <span class="ag-btns"><button class="chip" data-a="stop" hidden>Stop</button>${openAsChat ? `<button class="chip" data-a="open">Open as chat</button>` : ""}</span></div></div>
    <div class="ag-changed" hidden></div><div class="ag-chat"></div></div>`);
  ctx.view = new ChatView(ctx.el.querySelector(".ag-chat"), { embedded: true, scroller: () => $("#page-body") });
  ctx.head = () => {
    if (agentPage !== ctx) return;
    const a = chatAgents().find(x => x.key === ctx.key) || ctx.fallback?.();
    if (!a) return;
    const st = ctx.el.querySelector(".ag-hst");
    st.innerHTML = `<span class="ag-st ${agTone(a.status)}"></span>${a.now ? " · <span></span>" : ""}`;
    st.firstChild.textContent = AG_STATUS[a.status] || a.status;
    if (a.now) st.lastChild.textContent = a.now;
    ctx.el.querySelector(".ag-hmeta").innerHTML = agentMetaHtml(a, a.allowAll ? ["runs without asking until it's done"] : []);
    ctx.el.querySelector('[data-a="stop"]').hidden = !AG_ACTIVE.has(a.status);
    const files = a.report?.files || [], ch = ctx.el.querySelector(".ag-changed");
    ch.hidden = !files.length;
    if (files.length) ch.textContent = `${a.report.changed} changed: ` + files.map(f => f.replace(/^\S+\s+/, "")).join(", ");
  };
  return ctx.el;
}
function pageOpen(ctx, title, load) {
  agentPage = ctx;
  page.open(title, body => {
    agentPage = ctx;
    body.append(ctx.el);
    body.onscroll = () => { if (agentPage === ctx) ctx.view.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80; };
    ctx.head();
    if (!ctx.loaded) { ctx.loaded = true; load(); }
  }, "", () => {   // leaving for good (back or close), not for a step page on top
    if (agentPage === ctx) agentPage = null;
    $("#page-body").onscroll = null;
    clearInterval(ctx.timer);
    ctx.leave?.();
  }, { ltr: true });
}

/** A worker's own chat, live: its history, then its events as they come (subscribed while the page is open). */
function openWorkerPage(id) {
  const ctx = { key: "w:" + id, kind: "worker", id, lastSeq: 0, fallback: () => workerAgent(id, dsLinks()[id] || {}) };
  agentFrame(ctx, { openAsChat: true });
  ctx.el.querySelector('[data-a="stop"]').onclick = async () => { try { await conn.call("interrupt", { sessionId: id }); toast("Stopping…"); } catch (e) { toast(e.message); } };
  ctx.el.querySelector('[data-a="open"]').onclick = () => {
    const from = state.current?.sessionId;
    page.close();
    openSession(id).then(() => { state.backTo = { sessionId: from, worker: id }; });
  };
  ctx.leave = () => { if (state.current?.sessionId !== id) conn.call("unsubscribe", { sessionId: id }).catch(() => {}); };
  pageOpen(ctx, dsChatTitle(id) || "Worker", async () => {
    try {
      const hist = await conn.call("session.history", { sessionId: id });
      if (agentPage !== ctx) return;
      ctx.view.loadHistory(hist.messages || [], { live: AG_ACTIVE.has(dsLinkState(id)) });
      const sub = await conn.call("subscribe", { sessionId: id, after: 1e15 });
      if (sub.info) { state.liveInfo[id] = sub.info; ctx.lastSeq = sub.info.seq; if (sub.info.activity) state.activity[id] = sub.info.activity; }
    } catch (e) { ctx.view.note("Couldn't load this worker: " + e.message, true); }
    if (ctx.view.empty) ctx.view.note("Nothing here yet.");
    ctx.head();
    $("#page-body").scrollTop = 1e9;
    if (state.pending.some(p => p.sessionId === id)) showNextPermission();   // a request it's waiting on shows here too
  });
}
conn.on("ev", m => {
  const p = agentPage;
  if (!p || p.kind !== "worker" || m.sessionId !== p.id || m.seq <= p.lastSeq) return;
  p.lastSeq = m.seq;
  p.view.event(m.ev);
});

/** A subagent's own conversation (Claude Code keeps it next to the chat's), or a background command. */
function openTaskPage(a) {
  const sid = a.sid || state.current.sessionId;
  const ctx = { key: a.key, kind: a.kind, id: a.id, fallback: () => ({ ...a, status: "done", now: "" }) };
  agentFrame(ctx);
  ctx.el.querySelector('[data-a="stop"]').onclick = async () => { try { await conn.call("session.stopTask", { sessionId: sid, taskId: a.id }); toast("Stopping…"); } catch (e) { toast(e.message); } };
  const box = ctx.view.root;
  pageOpen(ctx, a.title, async () => {
    if (a.kind === "command") {
      const cmd = a.toolUseId && chat.tools.get(a.toolUseId)?.input?.command;
      box.innerHTML = (cmd ? `<pre class="ag-cmd"></pre>` : "") + `<p class="u-foot">A background command. Its output reaches Claude when it finishes.</p>`;
      if (cmd) box.querySelector(".ag-cmd").textContent = "$ " + cmd;
      return;
    }
    const load = async () => {
      let r; try { r = await conn.call("task.transcript", { sessionId: sid, taskId: a.id }); } catch (e) { return void (box.textContent = e.message); }
      if (agentPage !== ctx) return;
      if (!r.messages) { box.innerHTML = `<p class="u-foot">This agent's conversation isn't saved on this phone.</p>`; return; }
      const st = chatAgents().find(x => x.key === ctx.key)?.status;
      ctx.view.loadHistory(r.messages, { live: AG_ACTIVE.has(st) });   // only what's new is added
    };
    await load();
    $("#page-body").scrollTop = 1e9;
    ctx.timer = setInterval(() => {
      if (agentPage !== ctx) return;
      const st = chatAgents().find(x => x.key === ctx.key)?.status;
      if (st && AG_ACTIVE.has(st)) load(); else { clearInterval(ctx.timer); load(); }
    }, 3000);
  });
}

// ───────────── from the chat: a handoff line ─────────────
/** "Sent to DeepSeek: Add README · done ›" opens that worker on the Agents tab; one still waiting for your OK shows the
 *  approval; one that never ran shows what was asked and what came back. */
function openHandoff(card) {
  if (Date.now() - (sheet.closedAt || 0) < 400) return;   // the tap that closed a sheet
  const child = card.child || dsChildOf(card);
  if (child) { setTab("agents"); return openWorkerPage(child); }
  if (state.pending.some(p => p.toolUseID === card.id)) return showNextPermission();
  const st = handoffState(card), b = sheet.open(`<h2></h2><div class="sub"></div><div class="perm-detail md dl-task"></div>${card.report?.raw ? `<div class="sub ho-out"></div>` : ""}`, { key: "handoff" });
  b.querySelector("h2").textContent = st.lead;
  b.querySelector(".sub").textContent = st.title;
  setMd(b.querySelector(".dl-task"), card.input?.task || "");
  if (card.report?.raw) b.querySelector(".ho-out").textContent = card.report.raw.slice(0, 600);
}

// Android back: from the Agents tab to the chat; from a worker opened as a chat, back to the chat that started it.
function agentsBack() {
  const back = state.backTo;
  if (back && state.current?.sessionId === back.worker && back.sessionId) {
    state.backTo = null;
    openSession(back.sessionId).then(() => { setTab("agents"); openWorkerPage(back.worker); });
    return true;
  }
  if (state.tab === "agents") { setTab("chat"); return true; }
  return false;
}
