// sessions.js — the chat list drawer, session actions, and opening / starting chats
"use strict";



// ───────────── sessions drawer ─────────────
async function refreshSessions() {
  try { const r = await conn.call("sessions.list", { limit: 400 }); state.sessions = r.sessions; renderSessions(); renderProjects(); }
  catch (e) { console.warn(e); }
}
function sessionState(id) { const pend = state.pending.some(p => p.sessionId === id); if (pend) return "waiting"; return state.liveInfo[id]?.state || null; }
/** A chat's state with its workers': a worker's approval shows in the chat that started it, so it needs you there (#52). */
function chatState(id) {
  const st = sessionState(id);
  if (st === "waiting" || typeof requestWorker !== "function") return st;
  return state.pending.some(p => p.sessionId !== id && requestWorker(p)?.parent === id) ? "waiting" : st;
}
state.openKids = new Set();   // chats whose workers are shown in the drawer
function renderSessions() {
  const list = $("#session-list");
  const q = state.filter.toLowerCase();
  let items = state.sessions.filter(s => (!q || (s.title || "").toLowerCase().includes(q) || (s.firstPrompt || "").toLowerCase().includes(q) || (s.cwd || "").toLowerCase().includes(q))
    && (!state.project || s.cwd === state.project)
    && (typeof envFilterMatches !== "function" || envFilterMatches(s)));
  // live sessions not yet on disk (brand new)
  for (const id of Object.keys(state.liveInfo)) if (!state.sessions.some(s => s.sessionId === id)) {
    const i = state.liveInfo[id], env = typeof sessionEnvironment === "function" ? sessionEnvironment(id) : null;
    items.unshift({ sessionId: id, title: i.title || "New chat", cwd: i.cwd, lastModified: Date.now(), engine: i.engine, parent: i.parent,
      profile: i.profile || profileOfCwd(i.cwd)?.id,
      ...(env ? { remote: true, environment: env.id, environmentName: env.name, offline: env.offline } : {}) });
  }
  // With two or more profiles, the drawer's filter hides the chats outside the chosen one; a worker follows its parent.
  const links = typeof dsLinks === "function" ? dsLinks() : {};
  if (typeof profileMany === "function" && profileMany() && state.profileFilter) {
    // parents that search or the folder filter hid still say which profile their worker is in
    const byId = new Map(state.sessions.map(s => [s.sessionId, s]));
    for (const [id, i] of Object.entries(state.liveInfo)) if (!byId.has(id)) byId.set(id, { ...i, sessionId: id });
    items = items.filter(s => sessionProfileId(s, byId, links) === state.profileFilter);
  }
  // Workers sit under the chat that started them, folded (#52). A search lists whatever matches, workers too.
  const listed = new Set(items.map(s => s.sessionId)), kids = {};
  if (!q) items = items.filter(s => { const par = links[s.sessionId]?.parent; if (!par || !listed.has(par)) return true; (kids[par] ||= []).push(s); return false; });
  const curParent = links[state.current?.sessionId]?.parent;
  if (curParent) state.openKids.add(curParent);   // the worker on screen is never hidden
  const groups = { Pinned: [], Today: [], Yesterday: [], "Previous 7 days": [], Older: [] };
  const day = 864e5, startToday = new Date().setHours(0, 0, 0, 0);
  for (const s of items) {
    if (state.pinned.includes(s.sessionId)) groups.Pinned.push(s);
    else if (s.lastModified >= startToday) groups.Today.push(s);
    else if (s.lastModified >= startToday - day) groups.Yesterday.push(s);
    else if (s.lastModified >= startToday - 7 * day) groups["Previous 7 days"].push(s);
    else groups.Older.push(s);
  }
  list.innerHTML = "";
  for (const [g, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    list.append(h(`<div class="group-label">${g}</div>`));
    for (const s of arr) {
      const prof = typeof profileOfSession === "function" ? profileOfSession(s) : null;
      list.append(sessRow(s, false, prof));
      if (kids[s.sessionId]) list.append(kidsBlock(s.sessionId, kids[s.sessionId], prof));
    }
  }
  if (!list.children.length) list.innerHTML = `<div class="group-label" style="text-transform:none">${state.filter ? "No matching chats" : "No chats yet"}</div>`;
}
function sessRow(s, nested, prof) {
  const st = nested ? sessionState(s.sessionId) : chatState(s.sessionId);
  const env = typeof sessionEnvironment === "function" ? sessionEnvironment(s.sessionId) : null;
  const offline = env ? env.offline : !!s.offline;
  const row = h(`<button class="sess ${state.current?.sessionId === s.sessionId ? "on" : ""}${nested ? " kid" : ""}${offline ? " offline" : ""}">
    ${st || nested ? `<span class="dot ${st || ""}"></span>` : ""}${prof && typeof pdot === "function" ? pdot(prof) : ""}
    <div class="t"><div></div><div class="meta"></div></div>
    ${state.pinned.includes(s.sessionId) ? `<span class="pin">${icon("pin")}</span>` : ""}</button>`);
  row.querySelector(".t div").textContent = s.title || s.firstPrompt || "Untitled";
  // DeepSeek chats and worker chats say so (a nested worker's place already says it's a worker)
  const eng = s.parent && !nested ? (s.engine === "deepseek" ? "DeepSeek worker" : "Claude worker") : s.engine === "deepseek" ? "DeepSeek" : "";
  const meta = row.querySelector(".meta");
  meta.textContent = [baseName(s.cwd), relTime(s.lastModified),
    st === "waiting" ? "needs approval" : st === "running" ? "working" : s.elsewhere ? "open in Termux" : "",
    offline ? "offline" : "", eng].filter(Boolean).join(" · ");
  // a chat on another device says whose it is, first in the meta line
  if (env?.name) { const chip = document.createElement("span"); chip.className = "meta-env"; chip.textContent = envShort(env.name); meta.prepend(chip); }
  row.onclick = () => { closeDrawer(); openSession(s.sessionId); };
  longPress(row, () => sessionMenu(s));
  return row;
}
/** "▸ 2 workers · 1 needs you" under a chat; a tap shows them, folded again with another. */
function kidsBlock(parent, arr, prof) {
  const open = state.openKids.has(parent), states = arr.map(s => sessionState(s.sessionId));
  const needs = states.filter(x => x === "waiting").length, busy = states.filter(x => x === "running" || x === "starting").length;
  const box = h(`<div class="sess-kids${open ? " open" : ""}"><button class="kids-toggle" aria-expanded="${open}"><span class="kt-chev" aria-hidden="true">›</span>
    <span class="meta-part kt-n">${arr.length} worker${arr.length === 1 ? "" : "s"}</span>${needs ? `<span class="meta-sep"> · </span><span class="meta-part kt-st needs">${needs} need${needs === 1 ? "s" : ""} you</span>` : busy ? `<span class="meta-sep"> · </span><span class="meta-part kt-st">${busy} working</span>` : ""}</button>
    <div class="kids-list"></div></div>`);
  if (open) for (const s of arr) box.querySelector(".kids-list").append(sessRow(s, true, prof));
  box.querySelector(".kids-toggle").onclick = () => { if (state.openKids.has(parent)) state.openKids.delete(parent); else state.openKids.add(parent); renderSessions(); };
  return box;
}
function renderProjects() {
  const counts = {};
  for (const s of state.sessions) if (s.cwd) counts[s.cwd] = (counts[s.cwd] || 0) + 1;
  const dirs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 12);
  const box = $("#project-filters");
  box.innerHTML = "";
  if (dirs.length < 2) return;
  const all = h(`<button class="${!state.project ? "on" : ""}">All</button>`); all.onclick = () => { state.project = ""; renderProjects(); renderSessions(); };
  box.append(all);
  for (const d of dirs) {
    const b = h(`<button class="${state.project === d ? "on" : ""}"></button>`); b.textContent = baseName(d);
    b.onclick = () => { state.project = state.project === d ? "" : d; renderProjects(); renderSessions(); };
    box.append(b);
  }
}
function updateMenuBadge() { $("#menu-badge").hidden = !state.pending.some(p => typeof requestHere === "function" ? !requestHere(p) : p.sessionId !== state.current?.sessionId); }
$("#session-search").addEventListener("input", e => { state.filter = e.target.value; renderSessions(); });
$("#btn-menu").onclick = () => {
  document.body.classList.add("drawer-open"); nativeCall("setBackHandler", true); refreshSessions();
  // Staggered reveal of the list, only when the drawer opens (not on every live refresh).
  const list = $("#session-list"); list.classList.remove("stagger"); void list.offsetWidth; list.classList.add("stagger");
  setTimeout(() => list.classList.remove("stagger"), 900);
};
$("#scrim").onclick = closeDrawer;
function closeDrawer() { document.body.classList.remove("drawer-open"); }
// keep the folder of a chat on this phone; a device's folder only exists there
$("#btn-new").onclick = () => { closeDrawer(); const cur = state.current; newChat(cur && (typeof envIdOf !== "function" || !envIdOf(cur.sessionId)) ? cur.cwd : undefined); };
$("#btn-settings").onclick = () => { closeDrawer(); openSettings(); };

// A press and hold (480 ms) opens the row's menu; a tap opens the row. The press tolerates a little finger
// wobble, dies when Android cancels the touch, fires only once, and swallows the click the lifting finger sends
// (it would otherwise open the chat under the menu, or hit the menu's scrim and close it) (#58).
function longPress(el, fn) {
  let timer = 0, eatTimer = 0, x0 = 0, y0 = 0, fired = false;
  const point = e => (e.touches?.[0] || e.changedTouches?.[0] || {});
  const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };
  const eat = ev => { ev.preventDefault(); ev.stopPropagation(); };   // eats the click that ends the press
  const expireEat = () => {
    clearTimeout(eatTimer);
    eatTimer = setTimeout(() => removeEventListener("click", eat, { capture: true }), 800);
  };
  el.addEventListener("touchstart", e => {
    fired = false;
    const p = point(e); x0 = p.clientX ?? 0; y0 = p.clientY ?? 0;
    clear();
    timer = setTimeout(() => {
      timer = 0;
      if (fired) return;
      fired = true;
      addEventListener("click", eat, { capture: true, once: true });
      expireEat();
      haptic("long");
      fn();
    }, 480);
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    const p = point(e);
    if (Math.abs((p.clientX ?? 0) - x0) > 10 || Math.abs((p.clientY ?? 0) - y0) > 10) clear();
  }, { passive: true });
  el.addEventListener("touchend", () => { clear(); if (fired) expireEat(); }, { passive: true });
  el.addEventListener("touchcancel", () => { clear(); removeEventListener("click", eat, { capture: true }); }, { passive: true });
  // A touch press is handled above, so its contextmenu must not open the menu twice; a mouse's right-click still does.
  el.addEventListener("contextmenu", e => { e.preventDefault(); if (!fired && !timer) fn(); });
}

function sessionMenu(s) {
  const pinned = state.pinned.includes(s.sessionId);
  const live = !!state.liveInfo[s.sessionId];
  menuSheet(s.title || "Chat", [
    { label: "Rename", icon: "edit", run: () => renameSession(s.sessionId, s.title) },
    { label: pinned ? "Unpin" : "Pin", icon: "pin", run: async () => { const r = await conn.call("session.pin", { sessionId: s.sessionId, pinned: !pinned }); state.pinned = r.pinned; renderSessions(); } },
    { label: "Duplicate (fork)", icon: "fork", run: () => forkSession(s.sessionId) },
    native && !nativeCall("isStandalone") && { label: "Continue in Termux", icon: "terminal", run: () => nativeCall("openInTermux", s.cwd || state.home, s.sessionId) },
    { label: "Copy session ID", icon: "copy", run: () => copyText(s.sessionId) },
    live && { label: "Stop background process", icon: "stop", run: () => conn.call("session.close", { sessionId: s.sessionId }) },
    { label: "Delete", icon: "trash", danger: true, run: () => deleteSession(s.sessionId, s.title) },
  ]);
}
async function renameSession(id, current) {
  const t = await promptSheet({ title: "Rename chat", value: current || "" });
  if (!t) return;
  try { await conn.call("session.rename", { sessionId: id, title: t }); if (state.current?.sessionId === id) { state.current.title = t; updateHeader(); } toast("Renamed"); } catch (e) { toast(e.message); }
}
async function deleteSession(id, title) {
  if (!await confirmSheet({ title: "Delete this chat?", text: `"${title || "Untitled"}" will be permanently deleted from this device.`, ok: "Delete", danger: true })) return;
  try { await conn.call("session.delete", { sessionId: id }); if (state.current?.sessionId === id) newChat(state.current.cwd); toast("Deleted"); } catch (e) { toast(e.message); }
}
async function forkSession(id, upToMessageId) {
  try { const r = await conn.call("session.fork", { sessionId: id, upToMessageId }); await refreshSessions(); await openSession(r.sessionId); toast("Forked into a new chat"); return r.sessionId; }
  catch (e) { toast(e.message); }
}

// ───────────── open / new chat ─────────────
/** A live event for the chat on screen: the socket's path and a reconnect's replay both go through here (#62a). */
function chatLiveEvent(m) {
  const cur = state.current;
  if (!cur || m.sessionId !== cur.sessionId) return;
  if (m.seq <= (cur.lastSeq || 0)) return;
  cur.lastSeq = m.seq;
  hideEmpty();
  chat.event(m.ev);
  if (m.ev.type === "system" && m.ev.subtype === "init") { cur.model = m.ev.model; updateComposer(); }
}
/** What a subscribe reply says about the chat on screen; seq is the position the transcript already covers. */
function applySubscribe(sub, sessionId, seq) {
  if (sub.engine || sub.info?.engine) state.current.engine = sub.engine || sub.info.engine;
  state.current.account = sub.account || state.defaultAccount || "default";   // the Claude account this chat runs on
  if (sub.parent && typeof parentOf === "function") state.links[sessionId] = { ...state.links[sessionId], parent: parentOf(sub.parent) };
  if (sub.info) {
    state.liveInfo[sessionId] = sub.info;
    // An event may have arrived for this chat while the reply was in flight (and advanced the position):
    // never rewind past it, or the same event would be drawn twice.
    const at = Number.isFinite(seq) ? Math.min(seq, sub.info.seq) : sub.info.seq;
    state.current.lastSeq = Math.max(state.current.lastSeq || 0, at);
    if (sub.info.activity) state.activity[sessionId] = sub.info.activity;
  } else if (sub.settings) Object.assign(state.current, { model: sub.settings.model ?? null, effort: sub.settings.effort ?? null, permissionMode: sub.settings.permissionMode || state.current.permissionMode });
}

async function openSession(sessionId, { keepScroll, keepChat } = {}) {
  const prev = state.current;
  // Reconnecting the chat already on screen: if the server still has every event after its position, catch up
  // from there instead of rebuilding the chat — the reader keeps their place and a reply keeps streaming (#62b).
  if (keepChat && prev?.sessionId === sessionId && !prev.isNew && prev.lastSeq > 0) {
    const resume = prev.lastSeq;   // the position to catch up from (an event may arrive while we ask)
    try {
      const sub = await conn.call("subscribe", { sessionId, after: resume });
      if (state.current !== prev) return;
      if (sub.info && sub.info.seq >= resume && Number.isFinite(sub.firstSeq) && resume + 1 >= sub.firstSeq) {
        applySubscribe(sub, sessionId, resume);
        for (const e of sub.events || []) chatLiveEvent({ sessionId, ...e });
        setStatus(null); updateHeader(); updateComposer(); updateMenuBadge(); renderSessions();
        if (!keepScroll) scrollToBottom(true);
        showNextPermission();
        if (typeof accountsChatChanged === "function") accountsChatChanged();
        return;
      }
    } catch {}   // no catch-up possible: reload below
  }
  if (prev && prev.sessionId !== sessionId && !prev.isNew) conn.call("unsubscribe", { sessionId: prev.sessionId }).catch(() => {});
  const meta = state.sessions.find(s => s.sessionId === sessionId) || {};
  const info = state.liveInfo[sessionId];
  state.current = { sessionId, cwd: meta.cwd || info?.cwd || state.home, title: meta.title || info?.title || "Chat", isNew: false, lastSeq: 0, engine: meta.engine || info?.engine || undefined };
  if (typeof agentsChatChanged === "function" && prev?.sessionId !== sessionId) agentsChatChanged();
  chat.reset(); hideEmpty(); updateHeader(); updateComposer(); renderSessions();
  setStatus("Loading…");
  try {
    const hist = await conn.call("session.history", { sessionId });
    if (state.current?.sessionId !== sessionId) return;
    if (hist.info) { state.current.cwd = hist.info.cwd || state.current.cwd; state.current.title = hist.info.customTitle || hist.info.summary || state.current.title; }
    chat.loadHistory(hist.messages || []);
    // Subscribe after the seq the transcript read covered, then replay what it missed. A reply that was
    // mid-stream keeps its block start, and anything the transcript already has is deduped by uuid or block.
    const histSeq = Number.isFinite(hist.seq) ? hist.seq : null;
    const sub = await conn.call("subscribe", { sessionId, after: histSeq ?? 1e15 });
    if (state.current?.sessionId !== sessionId) return;
    applySubscribe(sub, sessionId, histSeq);
    for (const e of sub.events || []) chatLiveEvent({ sessionId, ...e });
  } catch (e) { chat.note("Couldn't load this chat: " + e.message, true); }
  setStatus(null);
  if (chat.empty) showEmpty();
  updateHeader(); updateComposer(); updateMenuBadge();
  if (!keepScroll) scrollToBottom(true);
  showNextPermission();
  if (typeof accountsChatChanged === "function") accountsChatChanged();   // its account chip, and no old limit card
}
/** engine: "claude" | "deepseek"; by default the one Settings → DeepSeek starts new chats on.
 *  envId: start it on another Pocket Agent server, with the id "<envId>:<uuid>" (the server proxies it). */
function newChat(cwd, engine, envId) {
  if (state.current && !state.current.isNew) conn.call("unsubscribe", { sessionId: state.current.sessionId }).catch(() => {});
  const env = envId && typeof envById === "function" ? envById(envId) : null;
  state.current = { sessionId: (envId ? envId + ":" : "") + uuid(), cwd: cwd || (env ? env.home || "" : state.defaults.cwd || state.home), title: "New chat", isNew: true, lastSeq: 0,
    model: state.defaults.model || null, effort: state.defaults.effort || null, permissionMode: state.defaults.permissionMode || "default" };
  if (typeof applyEngine === "function") { applyEngine(state.current, engine || defaultEngine()); state.current.engineChosen = !!engine; }
  if (typeof accountsNewChat === "function") accountsNewChat();   // a new chat starts on the default account
  if (typeof agentsChatChanged === "function") agentsChatChanged();
  chat.reset(); showEmpty(); updateHeader(); updateComposer(); renderSessions();
}
function showEmpty() {
  const cur = state.current;
  $("#empty").hidden = false;
  const hr = new Date().getHours();
  $("#empty-greet").textContent = hr < 5 ? "Burning the midnight oil?" : hr < 12 ? "Good morning. What's the plan?" : hr < 18 ? "What should we build?" : "Good evening. What's next?";
  const prof = typeof profileMany === "function" && profileMany() ? profileOfCwd(cur?.cwd) : null;
  $("#empty-cwd").innerHTML = `in <b>${esc(shortPath(cur?.cwd) || "~")}</b>${prof && typeof profileChip === "function" ? " · " + profileChip(prof) : ""} · <button id="chg-dir">change folder</button>`;
  $("#chg-dir").onclick = () => pickFolder(cur.cwd, typeof currentEnvId === "function" ? currentEnvId() : null).then(d => { if (d) { cur.cwd = d; showEmpty(); updateHeader(); } });
  if (typeof renderNewChatWhere === "function") renderNewChatWhere();
  const sg = $("#suggestions"); sg.innerHTML = "";
  for (const s of SUGGESTIONS) { const b = h(`<button></button>`); b.textContent = s; b.onclick = () => { input.value = s; autosize(); input.focus(); }; sg.append(b); }
}
function hideEmpty() { $("#empty").hidden = true; }
function updateHeader() {
  const cur = state.current; if (!cur) return;
  $("#chat-title").textContent = cur.isNew ? "New chat" : (cur.title || "Chat");
  const st = chatState(cur.sessionId);
  const elsewhere = !cur.isNew && state.sessions.find(s => s.sessionId === cur.sessionId)?.elsewhere;
  const ds = typeof chatEngine === "function" && chatEngine(cur.sessionId) === "deepseek" ? " · DeepSeek" : "";
  // a worker says so (the drawer has it under the chat that started it; Android back returns there)
  const worker = !cur.isNew && typeof workerParentOf === "function" && workerParentOf(cur.sessionId) ? (ds ? " worker" : " · Claude worker") : "";
  const prof = typeof profileMany === "function" && profileMany() ? profileOfCwd(cur.cwd) : null;
  // a chat on another device names it first (environments.js)
  const env = typeof sessionEnvironment === "function" ? sessionEnvironment(cur.sessionId) : null;
  $("#chat-sub").textContent = `${env ? env.name + " · " : ""}${shortPath(cur.cwd)}${prof ? " · " + prof.name : ""}${ds}${worker}${st === "running" ? " · working" : st === "waiting" ? " · needs approval" : elsewhere ? " · open in Termux" : ""}`;
  if (typeof renderEnvNotice === "function") renderEnvNotice();
  if (typeof renderTabs === "function") renderTabs();
}
