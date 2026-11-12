// sessions.js — the chat list drawer, session actions, and opening / starting chats
"use strict";



// ───────────── sessions drawer ─────────────
async function refreshSessions() {
  try { const r = await conn.call("sessions.list", { limit: 400 }); state.sessions = r.sessions; renderSessions(); renderProjects(); }
  catch (e) { console.warn(e); }
}
function sessionState(id) { const pend = state.pending.some(p => p.sessionId === id); if (pend) return "waiting"; return state.liveInfo[id]?.state || null; }
function renderSessions() {
  const list = $("#session-list");
  const q = state.filter.toLowerCase();
  let items = state.sessions.filter(s => (!q || (s.title || "").toLowerCase().includes(q) || (s.firstPrompt || "").toLowerCase().includes(q) || (s.cwd || "").toLowerCase().includes(q))
    && (!state.project || s.cwd === state.project));
  // live sessions not yet on disk (brand new)
  for (const id of Object.keys(state.liveInfo)) if (!state.sessions.some(s => s.sessionId === id)) {
    const i = state.liveInfo[id]; items.unshift({ sessionId: id, title: i.title || "New chat", cwd: i.cwd, lastModified: Date.now() });
  }
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
      const st = sessionState(s.sessionId);
      const row = h(`<button class="sess ${state.current?.sessionId === s.sessionId ? "on" : ""}">
        ${st ? `<span class="dot ${st}"></span>` : ""}
        <div class="t"><div></div><div class="meta"></div></div>
        ${state.pinned.includes(s.sessionId) ? `<span class="pin">${icon("pin")}</span>` : ""}</button>`);
      row.querySelector(".t div").textContent = s.title || s.firstPrompt || "Untitled";
      row.querySelector(".meta").textContent = `${baseName(s.cwd)} · ${relTime(s.lastModified)}${st === "waiting" ? " · needs approval" : st === "running" ? " · working" : s.elsewhere ? " · open in Termux" : ""}`;
      row.onclick = () => { closeDrawer(); openSession(s.sessionId); };
      longPress(row, () => sessionMenu(s));
      list.append(row);
    }
  }
  if (!list.children.length) list.innerHTML = `<div class="group-label" style="text-transform:none">${state.filter ? "No matching chats" : "No chats yet"}</div>`;
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
function updateMenuBadge() { $("#menu-badge").hidden = !state.pending.some(p => p.sessionId !== state.current?.sessionId); }
$("#session-search").addEventListener("input", e => { state.filter = e.target.value; renderSessions(); });
$("#btn-menu").onclick = () => {
  document.body.classList.add("drawer-open"); nativeCall("setBackHandler", true); refreshSessions();
  // Staggered reveal of the list, only when the drawer opens (not on every live refresh).
  const list = $("#session-list"); list.classList.remove("stagger"); void list.offsetWidth; list.classList.add("stagger");
  setTimeout(() => list.classList.remove("stagger"), 900);
};
$("#scrim").onclick = closeDrawer;
function closeDrawer() { document.body.classList.remove("drawer-open"); }
$("#btn-new").onclick = () => { closeDrawer(); newChat(state.current?.cwd); };
$("#btn-settings").onclick = () => { closeDrawer(); openSettings(); };

function longPress(el, fn) {
  let t, moved = false;
  el.addEventListener("touchstart", () => { moved = false; t = setTimeout(() => { if (!moved) { haptic("long"); fn(); } }, 480); }, { passive: true });
  el.addEventListener("touchmove", () => { moved = true; clearTimeout(t); }, { passive: true });
  el.addEventListener("touchend", e => { clearTimeout(t); }, { passive: true });
  el.addEventListener("contextmenu", e => { e.preventDefault(); fn(); });
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
async function openSession(sessionId, { keepScroll } = {}) {
  const prev = state.current;
  if (prev && prev.sessionId !== sessionId && !prev.isNew) conn.call("unsubscribe", { sessionId: prev.sessionId }).catch(() => {});
  const meta = state.sessions.find(s => s.sessionId === sessionId) || {};
  const info = state.liveInfo[sessionId];
  state.current = { sessionId, cwd: meta.cwd || info?.cwd || state.home, title: meta.title || info?.title || "Chat", isNew: false, lastSeq: 0 };
  chat.reset(); hideEmpty(); updateHeader(); updateComposer(); renderSessions();
  setStatus("Loading…");
  try {
    const hist = await conn.call("session.history", { sessionId });
    if (state.current?.sessionId !== sessionId) return;
    if (hist.info) { state.current.cwd = hist.info.cwd || state.current.cwd; state.current.title = hist.info.customTitle || hist.info.summary || state.current.title; }
    chat.loadHistory(hist.messages || []);
    // Live session: get only events newer than what the transcript already shows.
    const sub = await conn.call("subscribe", { sessionId, after: 1e15 });
    if (sub.info) { state.liveInfo[sessionId] = sub.info; state.current.lastSeq = sub.info.seq; if (sub.info.activity) state.activity[sessionId] = sub.info.activity; }
  } catch (e) { chat.note("Couldn't load this chat: " + e.message, true); }
  setStatus(null);
  if (chat.empty) showEmpty();
  updateHeader(); updateComposer(); updateMenuBadge();
  if (!keepScroll) scrollToBottom(true);
  showNextPermission();
}
function newChat(cwd) {
  if (state.current && !state.current.isNew) conn.call("unsubscribe", { sessionId: state.current.sessionId }).catch(() => {});
  state.current = { sessionId: uuid(), cwd: cwd || state.defaults.cwd || state.home, title: "New chat", isNew: true, lastSeq: 0,
    model: state.defaults.model || null, effort: state.defaults.effort || null, permissionMode: state.defaults.permissionMode || "default" };
  chat.reset(); showEmpty(); updateHeader(); updateComposer(); renderSessions();
}
function showEmpty() {
  const cur = state.current;
  $("#empty").hidden = false;
  const hr = new Date().getHours();
  $("#empty-greet").textContent = hr < 5 ? "Burning the midnight oil?" : hr < 12 ? "Good morning. What's the plan?" : hr < 18 ? "What should we build?" : "Good evening. What's next?";
  $("#empty-cwd").innerHTML = `in <b>${esc(shortPath(cur?.cwd) || "~")}</b> · <button id="chg-dir">change folder</button>`;
  $("#chg-dir").onclick = () => pickFolder(cur.cwd).then(d => { if (d) { cur.cwd = d; showEmpty(); updateHeader(); } });
  const sg = $("#suggestions"); sg.innerHTML = "";
  for (const s of SUGGESTIONS) { const b = h(`<button></button>`); b.textContent = s; b.onclick = () => { input.value = s; autosize(); input.focus(); }; sg.append(b); }
}
function hideEmpty() { $("#empty").hidden = true; }
function updateHeader() {
  const cur = state.current; if (!cur) return;
  $("#chat-title").textContent = cur.isNew ? "New chat" : (cur.title || "Chat");
  const st = sessionState(cur.sessionId);
  const elsewhere = !cur.isNew && state.sessions.find(s => s.sessionId === cur.sessionId)?.elsewhere;
  $("#chat-sub").textContent = `${shortPath(cur.cwd)}${st === "running" ? " · working" : st === "waiting" ? " · needs approval" : elsewhere ? " · open in Termux" : ""}`;
}
