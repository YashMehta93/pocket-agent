// app.js — UI wiring: drawer, sessions, composer, pickers, approvals, pages.
"use strict";

const chat = new ChatView($("#messages"));
const input = $("#input");
let attachments = [];  // {kind:"image"|"file", name, mediaType, data, size}
let runTimer = null;

const MODES = [
  { id: "default", label: "Ask before acting", short: "Ask", desc: "Claude asks before editing files or running commands." },
  { id: "acceptEdits", label: "Auto-accept edits", short: "Auto-edit", desc: "File edits go through; commands still ask." },
  { id: "plan", label: "Plan mode", short: "Plan", desc: "Claude researches and proposes a plan without changing anything." },
  { id: "auto", label: "Auto mode", short: "Auto", desc: "A safety classifier approves routine actions and asks about risky ones." },
  { id: "bypassPermissions", label: "Bypass permissions", short: "Bypass", desc: "Everything runs without asking. Only for trusted, sandboxed work.", warn: true },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SUGGESTIONS = ["Explain what this project does and how it's organized", "Find and fix a bug in this folder", "Write tests for the main module", "Set up a new Android app project here"];

// ───────────── boot ─────────────
hydrateIcons();
applySettings();
conn.on("open", onConnected);
conn.on("close", () => showBanner("Connection lost. Reconnecting…"));
conn.on("retrying", async n => {
  if (n < 3) return;
  if (await conn.probe() === "up") showBanner("The server is running but this app isn't paired with it yet.", "Pair", pairServer);
  else showBanner(native ? "Starting the Claude server in Termux… If this takes long, open Termux and run: pocket-agent start" : "Can't reach the server.", native ? "Open Termux" : null, () => nativeCall("openTermux"));
});
async function pairServer() {
  const tok = await promptSheet({ title: "Pair with the server", placeholder: "Paste the token here", ok: "Pair",
    value: "" });
  if (!tok) return;
  settings.token = tok.trim(); saveSettings();
  conn.ws?.close(); conn.connect(); toast("Pairing…");
}
conn.connect();
newChat();

async function onConnected() {
  hideBanner();
  const hello = await conn.call("hello");
  Object.assign(state, { home: hello.home, hostName: hello.host, defaults: hello.defaults || {}, pinned: hello.pinned || [],
    commands: hello.commands || [], models: hello.models || [], account: hello.account });
  for (const i of hello.live || []) state.liveInfo[i.sessionId] = i;
  state.pending = (hello.live || []).flatMap(i => i.pending || []);
  $("#conn-foot").innerHTML = `${icon("wifi")}<span>${esc(native ? "Termux" : hello.host)} · server ${esc(hello.version)}</span>`;
  await refreshSessions();
  const cur = state.current;
  if (cur && !cur.isNew) await openSession(cur.sessionId, { keepScroll: true });
  else updateHeader();
  updateComposer();
  if (window.__pendingIntent) { const i = window.__pendingIntent; window.__pendingIntent = null; handleIntent(i); }
}
function showBanner(text, action, fn) {
  const b = $("#banner"); b.hidden = false;
  b.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ""}`;
  if (action) b.querySelector("button").onclick = fn;
}
function hideBanner() { $("#banner").hidden = true; }

// ───────────── server events ─────────────
conn.on("ev", m => {
  const cur = state.current;
  if (!cur || m.sessionId !== cur.sessionId) return;
  if (m.seq <= (cur.lastSeq || 0)) return;
  cur.lastSeq = m.seq;
  hideEmpty();
  chat.event(m.ev);
  if (m.ev.type === "system" && m.ev.subtype === "init") { cur.model = m.ev.model; updateComposer(); }
});
conn.on("state", m => {
  state.liveInfo[m.sessionId] = m.info;
  if (m.state === "closed") delete state.liveInfo[m.sessionId];
  if (state.current?.sessionId === m.sessionId) { updateComposer(); updateHeader(); }
  renderSessions();
  if (m.state === "idle") debouncedRefresh();
});
conn.on("permission.request", m => {
  state.pending = state.pending.filter(p => p.requestId !== m.requestId).concat(m);
  haptic("alert");
  updateMenuBadge(); renderSessions();
  if (state.current?.sessionId === m.sessionId) showNextPermission();
});
conn.on("permission.resolved", m => {
  state.pending = state.pending.filter(p => p.requestId !== m.requestId);
  if (sheet.key === "perm:" + m.requestId) sheet.close(true);
  updateMenuBadge(); renderSessions();
  if (state.current?.sessionId === m.sessionId) showNextPermission();
});
conn.on("meta", m => { state.commands = m.commands || state.commands; state.models = m.models || state.models; state.account = m.account || state.account; updateComposer(); });
conn.on("sessions.changed", () => debouncedRefresh());
const debouncedRefresh = debounce(refreshSessions, 400);

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
      row.querySelector(".meta").textContent = `${baseName(s.cwd)} · ${relTime(s.lastModified)}${st === "waiting" ? " · needs approval" : st === "running" ? " · working" : ""}`;
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
$("#btn-menu").onclick = () => { document.body.classList.add("drawer-open"); nativeCall("setBackHandler", true); refreshSessions(); };
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
    native && { label: "Continue in Termux", icon: "terminal", run: () => nativeCall("openInTermux", s.cwd || state.home, s.sessionId) },
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
    if (sub.info) { state.liveInfo[sessionId] = sub.info; state.current.lastSeq = sub.info.seq; }
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
  $("#chat-sub").textContent = `${shortPath(cur.cwd)}${st === "running" ? " · working" : st === "waiting" ? " · needs approval" : ""}`;
}

// ───────────── composer ─────────────
function currentSettings() {
  const cur = state.current || {}; const li = state.liveInfo[cur.sessionId];
  return { model: li?.model ?? cur.model ?? state.defaults.model ?? null, effort: li?.effort ?? cur.effort ?? state.defaults.effort ?? null,
    permissionMode: li?.permissionMode ?? cur.permissionMode ?? state.defaults.permissionMode ?? "default" };
}
function modelLabel(id) {
  if (!id) return "Default model";
  const m = state.models.find(x => x.value === id || x.resolvedModel === id);
  return m ? m.displayName : id.replace(/^claude-/, "").replace(/-/g, " ");
}
function updateComposer() {
  const s = currentSettings();
  const mode = MODES.find(m => m.id === s.permissionMode) || MODES[0];
  const chipMode = $("#chip-mode"); chipMode.textContent = mode.short; chipMode.classList.toggle("warn", !!mode.warn || mode.id === "auto");
  $("#chip-model").textContent = modelLabel(s.model) + (s.effort ? " · " + s.effort : "");
  const st = sessionState(state.current?.sessionId);
  const running = st === "running" || st === "waiting";
  const send = $("#btn-send");
  const hasText = input.value.trim() || attachments.length;
  send.classList.toggle("stop", running && !hasText);
  send.innerHTML = icon(running && !hasText ? "stop" : "up");
  send.disabled = !running && !hasText;
  send.setAttribute("aria-label", running && !hasText ? "Stop" : "Send");
  if (running) startRunTimer(st); else stopRunTimer();
}
function startRunTimer(st) {
  if (st === "waiting") { setStatus("Waiting for your approval", false); return; }
  if (runTimer) return;
  const t0 = chat.turnStart || Date.now();
  const tick = () => setStatus(`Working… ${fmtDur(Math.floor((Date.now() - t0) / 1000) * 1000)}`, true);
  tick(); runTimer = setInterval(tick, 1000);
}
function stopRunTimer() { clearInterval(runTimer); runTimer = null; setStatus(null); }
function setStatus(text, spin = true) {
  const el = $("#status-line");
  if (!text) { el.hidden = true; return; }
  el.hidden = false; el.innerHTML = `${spin ? '<span class="spark"></span>' : icon("info")}<span>${esc(text)}</span>`;
}
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + "px"; updateComposer(); }
input.addEventListener("input", () => { autosize(); updatePopup(); });
input.addEventListener("keydown", e => {
  if (!$("#popup").hidden && popupKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey && (settings.enterToSend || e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});
$("#btn-send").onclick = () => {
  const st = sessionState(state.current?.sessionId);
  if ((st === "running" || st === "waiting") && !input.value.trim() && !attachments.length) return interrupt();
  send();
};
async function interrupt() {
  haptic("tick");
  try { await conn.call("interrupt", { sessionId: state.current.sessionId }); } catch (e) { toast(e.message); }
}
async function send(textOverride) {
  const cur = state.current;
  let text = (textOverride ?? input.value).trim();
  if (!text && !attachments.length) return;
  if (!conn.ok) return toast("Not connected to the server yet");
  haptic("tick");
  const images = attachments.filter(a => a.kind === "image").map(a => ({ mediaType: a.mediaType, data: a.data }));
  const files = attachments.filter(a => a.kind === "file");
  try {
    if (files.length) {
      const paths = [];
      for (const f of files) { const r = await conn.call("upload", { cwd: cur.cwd, name: f.name, data: f.data }); paths.push(r.path); }
      text = (text ? text + "\n\n" : "") + paths.map(p => `Attached file: @${p}`).join("\n");
    }
    if (textOverride === undefined) { input.value = ""; attachments = []; renderAttachments(); autosize(); }
    $("#popup").hidden = true;
    hideEmpty();
    const s = currentSettings();
    const msg = { sessionId: cur.sessionId, text, images };
    if (cur.isNew) Object.assign(msg, { cwd: cur.cwd, model: s.model || undefined, effort: s.effort || undefined, permissionMode: s.permissionMode });
    if (cur.isNew) { cur.isNew = false; cur.title = text.slice(0, 60); updateHeader(); }
    await conn.call("send", msg);
    scrollToBottom(true);
    debouncedRefresh();
  } catch (e) { toast(e.message); chat.note("Couldn't send: " + e.message, true); }
}

// attachments
$("#btn-attach").onclick = () => menuSheet("Attach", [
  { label: "Photos & images", icon: "image", run: () => pickFiles("image/*") },
  native && { label: "Take a photo", icon: "camera", run: () => nativeCall("takePhoto") },
  { label: "Files", icon: "file", run: () => pickFiles("*/*") },
  { label: "Mention a project file (@)", icon: "search", run: () => { insertAtCursor("@"); updatePopup(); } },
]);
function pickFiles(accept) { const fi = $("#file-input"); fi.accept = accept; fi.value = ""; fi.click(); }
$("#file-input").addEventListener("change", e => addFiles([...e.target.files]));
async function addFiles(files) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; }
    const data = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(String(rd.result).split(",")[1]); rd.readAsDataURL(f); });
    const isImg = /^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.size < 5 * 1024 * 1024;
    attachments.push({ kind: isImg ? "image" : "file", name: f.name, mediaType: f.type || "application/octet-stream", data, size: f.size });
  }
  renderAttachments(); updateComposer();
}
callbacks.photo = p => { if (p?.data) { attachments.push({ kind: "image", name: p.name || "photo.jpg", mediaType: p.mediaType || "image/jpeg", data: p.data }); renderAttachments(); updateComposer(); } };
function renderAttachments() {
  const box = $("#attachments"); box.innerHTML = ""; box.hidden = !attachments.length;
  attachments.forEach((a, i) => {
    const el = h(`<div class="att">${a.kind === "image" ? `<img src="data:${a.mediaType};base64,${a.data}">` : icon("file")}<span></span><button aria-label="Remove">${icon("x")}</button></div>`);
    el.querySelector("span").textContent = a.name;
    el.querySelector("button").onclick = () => { attachments.splice(i, 1); renderAttachments(); updateComposer(); };
    box.append(el);
  });
}

// voice input
$("#btn-mic").onclick = () => {
  if (native) { haptic("tick"); nativeCall("startVoice"); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Voice input needs the Android app");
  const r = new SR(); r.onresult = e => { insertAtCursor(e.results[0][0].transcript); autosize(); }; r.start();
};
callbacks.voice = t => { if (t) { insertAtCursor((input.value && !/\s$/.test(input.value) ? " " : "") + t); autosize(); input.focus(); } };
function insertAtCursor(t) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + t + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + t.length;
}

// ───────────── autocomplete popup (/ commands, @ files) ─────────────
let popupItems = [], popupSel = 0, popupCtx = null;
const updatePopup = debounce(async () => {
  const v = input.value, pos = input.selectionStart;
  const before = v.slice(0, pos);
  const slash = before.match(/^\/([\w:-]*)$/);
  const at = before.match(/(?:^|\s)@([^\s]*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const cmds = state.commands.length ? state.commands : (state.commandNames || []).map(n => ({ name: n, description: "" }));
    popupItems = cmds.filter(c => c.name.toLowerCase().includes(q) || (c.aliases || []).some(a => a.includes(q)))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q)) - (a.name.toLowerCase().startsWith(q))).slice(0, 40)
      .map(c => ({ label: "/" + c.name + (c.argumentHint ? " " + c.argumentHint : ""), desc: c.description, insert: "/" + c.name + " " }));
    popupCtx = { start: 0, end: pos };
  } else if (at) {
    try { const r = await conn.call("fs.search", { cwd: state.current.cwd, q: at[1] });
      popupItems = r.results.map(x => ({ label: x.path + (x.dir ? "/" : ""), desc: x.dir ? "folder" : "", insert: "@" + x.path + (x.dir ? "/" : " ") }));
    } catch { popupItems = []; }
    popupCtx = { start: pos - at[1].length - 1, end: pos };
  } else popupItems = [];
  renderPopup();
}, 120);
function renderPopup() {
  const p = $("#popup");
  if (!popupItems.length) { p.hidden = true; return; }
  popupSel = 0; p.hidden = false; p.innerHTML = "";
  popupItems.forEach((it, i) => {
    const b = h(`<button class="${i === 0 ? "sel" : ""}"><div class="n"></div>${it.desc ? `<div class="d"></div>` : ""}</button>`);
    b.querySelector(".n").textContent = it.label; if (it.desc) b.querySelector(".d").textContent = it.desc;
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => choosePopup(i);
    p.append(b);
  });
}
function choosePopup(i) {
  const it = popupItems[i]; if (!it) return;
  input.value = input.value.slice(0, popupCtx.start) + it.insert + input.value.slice(popupCtx.end);
  const c = popupCtx.start + it.insert.length; input.selectionStart = input.selectionEnd = c;
  $("#popup").hidden = true; popupItems = []; input.focus(); autosize();
}
function popupKey(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { popupSel = (popupSel + (e.key === "ArrowDown" ? 1 : -1) + popupItems.length) % popupItems.length; $$("#popup button").forEach((b, i) => b.classList.toggle("sel", i === popupSel)); e.preventDefault(); return true; }
  if (e.key === "Tab" || (e.key === "Enter" && popupItems.length)) { choosePopup(popupSel); e.preventDefault(); return true; }
  if (e.key === "Escape") { $("#popup").hidden = true; return true; }
  return false;
}

// ───────────── mode / model pickers ─────────────
$("#chip-mode").onclick = () => {
  const cur = currentSettings();
  const b = sheet.open(`<h2>Permission mode</h2><div class="sub">How much Claude can do without asking.</div><div id="modes"></div>`);
  for (const m of MODES) {
    const o = h(`<button class="opt ${m.id === cur.permissionMode ? "on" : ""}">${icon(m.id === cur.permissionMode ? "ccheck" : "circle")}<div class="ot"><div>${esc(m.label)}</div><div class="od">${esc(m.desc)}</div></div></button>`);
    o.onclick = async () => {
      if (m.id === "bypassPermissions" && !await confirmSheet({ title: "Bypass all permissions?", text: "Claude will run any command and edit any file without asking.", ok: "Bypass", danger: true })) return;
      sheet.close(true); applySetting({ permissionMode: m.id });
    };
    b.querySelector("#modes").append(o);
  }
};
$("#chip-model").onclick = () => {
  const cur = currentSettings();
  const models = state.models.length ? state.models : [{ value: "", displayName: "Default", description: "Start a chat once to load the model list" }];
  const b = sheet.open(`<h2>Model</h2><div id="models"></div><h2 style="margin-top:16px">Effort</h2><div class="sub">Higher effort thinks longer and uses more of your limits.</div><div class="seg" id="efforts"></div>`);
  for (const m of models) {
    const on = (cur.model || "") === (m.value || "") || (cur.model && m.resolvedModel === cur.model);
    const o = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div>${esc(m.displayName)}</div><div class="od">${esc(m.description || "")}</div></div></button>`);
    o.onclick = () => { sheet.close(true); applySetting({ model: m.value || null }); };
    b.querySelector("#models").append(o);
  }
  const sel = models.find(m => m.value === cur.model) || models[0];
  const levels = sel?.supportedEffortLevels?.length ? sel.supportedEffortLevels : EFFORTS;
  const seg = b.querySelector("#efforts");
  for (const e of ["", ...levels]) {
    const x = h(`<button class="${(cur.effort || "") === e ? "on" : ""}">${e || "auto"}</button>`);
    x.onclick = () => { sheet.close(true); applySetting({ effort: e || null }); };
    seg.append(x);
  }
};
async function applySetting(patch) {
  const cur = state.current;
  Object.assign(cur, patch);
  if (state.liveInfo[cur.sessionId]) {
    try { const r = await conn.call("set", { sessionId: cur.sessionId, ...patch }); if (r.info) state.liveInfo[cur.sessionId] = r.info; } catch (e) { toast(e.message); }
  }
  updateComposer();
}

// ───────────── approvals ─────────────
function showNextPermission() {
  const cur = state.current;
  const p = state.pending.find(x => x.sessionId === cur?.sessionId);
  if (!p) { if (sheet.key?.startsWith("perm:")) sheet.close(true); updateComposer(); return; }
  if (sheet.key === "perm:" + p.requestId) return;
  if (p.toolName === "AskUserQuestion") return askQuestionSheet(p);
  if (p.toolName === "ExitPlanMode") return planSheet(p);
  const inp = p.input || {};
  let detail = "";
  if (p.toolName === "Bash") detail = `<pre>$ ${esc(inp.command)}</pre>${inp.description ? `<div class="sub" style="margin-top:6px">${esc(inp.description)}</div>` : ""}`;
  else if (p.toolName === "Edit" || p.toolName === "MultiEdit" || p.toolName === "Write") detail = `<div class="sub">${esc(shortPath(inp.file_path))}</div><div id="perm-diff"></div>`;
  else if (p.toolName === "WebFetch") detail = `<pre>${esc(inp.url)}</pre>${inp.prompt ? `<div class="sub">${esc(inp.prompt)}</div>` : ""}`;
  else detail = `<pre>${esc(JSON.stringify(inp, null, 2))}</pre>`;
  const canAlways = (p.suggestions || []).length > 0;
  const b = sheet.open(`<h2>Allow ${esc(prettyToolName(p.toolName))}?</h2>
    ${p.decisionReason ? `<div class="sub">${esc(p.decisionReason)}</div>` : ""}${p.blockedPath ? `<div class="sub">Outside the project: ${esc(shortPath(p.blockedPath))}</div>` : ""}
    <div class="perm-detail">${detail}</div>
    <div class="btns"><button class="btn primary" data-a="allow">Allow</button>
    ${canAlways ? `<button class="btn" data-a="always">Allow and don't ask again${p.toolName === "Bash" ? " for this command" : ""}</button>` : ""}
    <div class="btns row2" style="margin-top:0"><button class="btn danger" data-a="deny">Deny</button><button class="btn ghost" data-a="tell">Deny & say why</button></div></div>`,
    { key: "perm:" + p.requestId });
  const dd = b.querySelector("#perm-diff");
  if (dd) {
    if (p.toolName === "Write") dd.append(codeBlock(inp.content || "", langOf(inp.file_path)));
    else if (p.toolName === "Edit") dd.append(diffView(diffLines(inp.old_string, inp.new_string)).el);
    else for (const e of inp.edits || []) dd.append(diffView(diffLines(e.old_string, e.new_string)).el);
  }
  const reply = async (behavior, extra = {}) => {
    haptic("tick"); sheet.close(true);
    try { await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior, ...extra }); } catch (e) { toast(e.message); }
  };
  b.querySelector('[data-a="allow"]').onclick = () => reply("allow");
  b.querySelector('[data-a="always"]')?.addEventListener("click", () => reply("allow", { always: true }));
  b.querySelector('[data-a="deny"]').onclick = () => reply("deny");
  b.querySelector('[data-a="tell"]').onclick = async () => { const why = await promptSheet({ title: "What should Claude do instead?", multiline: true, ok: "Send" }); if (why) reply("deny", { message: why }); else showNextPermission(); };
}
function askQuestionSheet(p) {
  const qs = p.input?.questions || [];
  const answers = {};
  const b = sheet.open(`<h2>Claude has ${qs.length > 1 ? "some questions" : "a question"}</h2><div id="qs"></div>
    <div class="btns"><button class="btn primary" data-a="ok">Submit answers</button><button class="btn ghost" data-a="skip">Skip</button></div>`, { key: "perm:" + p.requestId });
  qs.forEach(q => {
    const blk = h(`<div class="q-block"><div class="qh">${esc(q.header || "")}</div><div style="margin:2px 0 6px">${esc(q.question)}</div></div>`);
    const chosen = new Set();
    (q.options || []).forEach(o => {
      const btn = h(`<button class="opt">${icon("circle")}<div class="ot"><div>${esc(o.label)}</div><div class="od">${esc(o.description || "")}</div></div></button>`);
      btn.onclick = () => {
        if (!q.multiSelect) { chosen.clear(); blk.querySelectorAll(".opt").forEach(x => { x.classList.remove("on"); x.querySelector("svg").outerHTML = icon("circle"); }); }
        if (chosen.has(o.label)) chosen.delete(o.label); else chosen.add(o.label);
        btn.classList.toggle("on", chosen.has(o.label)); btn.querySelector("svg").outerHTML = icon(chosen.has(o.label) ? "ccheck" : "circle");
        answers[q.question] = [...chosen].join(", ");
      };
      blk.append(btn);
    });
    const other = h(`<input class="field" placeholder="Other (type your own answer)">`);
    other.oninput = () => { if (other.value.trim()) answers[q.question] = other.value.trim(); else answers[q.question] = [...chosen].join(", "); };
    blk.append(other);
    b.querySelector("#qs").append(blk);
  });
  b.querySelector('[data-a="ok"]').onclick = async () => {
    sheet.close(true);
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "allow", updatedInput: { ...p.input, answers } }).catch(e => toast(e.message));
  };
  b.querySelector('[data-a="skip"]').onclick = async () => { sheet.close(true); await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "deny", message: "The user skipped the questions." }).catch(() => {}); };
}
function planSheet(p) {
  const b = sheet.open(`<h2>Ready to start?</h2><div class="sub">Claude finished planning. Review the plan:</div><div class="perm-detail md" id="plan-md"></div>
    <div class="btns"><button class="btn primary" data-a="auto">Yes, auto-accept edits</button><button class="btn" data-a="ask">Yes, ask before each edit</button>
    <button class="btn ghost" data-a="no">No, keep planning…</button></div>`, { key: "perm:" + p.requestId });
  setMd(b.querySelector("#plan-md"), p.input?.plan || "");
  const go = async (mode) => {
    sheet.close(true);
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "allow" }).catch(e => toast(e.message));
    applySetting({ permissionMode: mode });
  };
  b.querySelector('[data-a="auto"]').onclick = () => go("acceptEdits");
  b.querySelector('[data-a="ask"]').onclick = () => go("default");
  b.querySelector('[data-a="no"]').onclick = async () => {
    const why = await promptSheet({ title: "What should change in the plan?", multiline: true, ok: "Send" });
    await conn.call("permission.reply", { sessionId: p.sessionId, requestId: p.requestId, behavior: "deny", message: why || "Keep planning. The user wants changes to the plan." }).catch(() => {});
  };
}

// ───────────── edit / retry (fork-based) ─────────────
async function editMessage(uuid, oldText) {
  const cur = state.current;
  const canRewind = !!state.liveInfo[cur.sessionId];
  const b = sheet.open(`<h2>Edit message</h2><div class="sub">This starts a new branch of the chat from here; the original stays in your history.</div>
    <textarea class="field" id="ed-text"></textarea>
    ${canRewind ? `<div class="set-row"><div class="l">Undo file changes made after this message<small>Restores files Claude edited since then</small></div><button class="switch" id="ed-rw"></button></div>` : ""}
    <div class="btns row2"><button class="btn ghost" data-a="c">Cancel</button><button class="btn primary" data-a="s">Send</button></div>`);
  const ta = b.querySelector("#ed-text"); ta.value = oldText;
  const rw = b.querySelector("#ed-rw"); if (rw) rw.onclick = () => rw.classList.toggle("on");
  b.querySelector('[data-a="c"]').onclick = () => sheet.close(true);
  b.querySelector('[data-a="s"]').onclick = async () => {
    const text = ta.value.trim(); if (!text) return;
    const rewind = rw?.classList.contains("on");
    sheet.close(true);
    await branchFrom(uuid, text, rewind);
  };
}
async function branchFrom(uuid, text, rewindFiles) {
  const cur = state.current;
  try {
    if (rewindFiles) { const r = await conn.call("session.rewindFiles", { sessionId: cur.sessionId, userMessageId: uuid }); if (r.result?.canRewind === false) toast(r.result.error || "Couldn't undo file changes"); }
    const prev = chat.prevUuid(uuid);
    if (!prev) { newChat(cur.cwd); await send(text); return; }
    const r = await conn.call("session.fork", { sessionId: cur.sessionId, upToMessageId: prev, title: cur.title });
    await refreshSessions();
    await openSession(r.sessionId);
    await send(text);
  } catch (e) { toast(e.message); }
}
function retryLast() {
  const u = chat.lastUserUuid();
  if (!u) return toast("Nothing to retry");
  branchFrom(u, chat.userTexts.get(u), false);
}

// ───────────── overflow menu ─────────────
$("#btn-more").onclick = () => {
  const cur = state.current; const live = !!state.liveInfo[cur.sessionId];
  menuSheet(null, [
    !cur.isNew && { label: "Rename", icon: "edit", run: () => renameSession(cur.sessionId, cur.title) },
    !cur.isNew && { label: state.pinned.includes(cur.sessionId) ? "Unpin" : "Pin", icon: "pin", run: async () => { const r = await conn.call("session.pin", { sessionId: cur.sessionId, pinned: !state.pinned.includes(cur.sessionId) }); state.pinned = r.pinned; renderSessions(); } },
    live && { label: "Context usage", icon: "chart", run: showContext },
    { label: "Commands & skills", icon: "bolt", run: showCommands },
    !cur.isNew && { label: "Fork this chat", icon: "fork", run: () => forkSession(cur.sessionId) },
    !cur.isNew && { label: "Export / share chat", icon: "share", run: () => shareText(`# ${cur.title}\n\n${chat.toMarkdown()}`, cur.title) },
    !cur.isNew && native && { label: "Continue in Termux", icon: "terminal", run: () => nativeCall("openInTermux", cur.cwd, cur.sessionId) },
    live && { label: "Stop background process", icon: "stop", run: () => conn.call("session.close", { sessionId: cur.sessionId }) },
    !cur.isNew && { label: "Delete chat", icon: "trash", danger: true, run: () => deleteSession(cur.sessionId, cur.title) },
  ]);
};
$("#title-wrap").onclick = () => { if (!state.current.isNew) renameSession(state.current.sessionId, state.current.title); };
async function showContext() {
  try {
    const { usage: u } = await conn.call("session.context", { sessionId: state.current.sessionId });
    const cats = (u.categories || []).filter(c => c.tokens > 0);
    const b = sheet.open(`<h2>Context: ${Math.round(u.percentage)}% used</h2><div class="sub">${fmtTok(u.totalTokens)} of ${fmtTok(u.maxTokens)} tokens · ${esc(u.model || "")}</div>
      <div class="ctx-bar">${cats.filter(c => c.kind !== "free").map(c => `<i style="width:${(c.tokens / u.maxTokens * 100).toFixed(2)}%;background:${esc(c.color)}"></i>`).join("")}</div>
      ${cats.map(c => `<div class="ctx-row"><span><i style="background:${esc(c.color)}"></i>${esc(c.name)}</span><span>${fmtTok(c.tokens)}</span></div>`).join("")}
      <div class="btns"><button class="btn" id="ctx-compact">Compact conversation now</button></div>`);
    b.querySelector("#ctx-compact").onclick = () => { sheet.close(true); send("/compact"); };
  } catch (e) { toast(e.message); }
}
function showCommands() {
  page.open("Commands & skills", body => {
    const list = state.commands.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) body.innerHTML = `<div class="settings"><p>Start a chat once to load your commands and skills.</p></div>`;
    for (const c of list) {
      const r = h(`<button class="list-row">${icon(c.builtin ? "terminal" : "bolt")}<div class="t"><div class="n"></div><div class="m" style="white-space:normal"></div></div></button>`);
      r.querySelector(".n").textContent = "/" + c.name + (c.argumentHint ? " " + c.argumentHint : ""); r.querySelector(".m").textContent = c.description || "";
      r.onclick = () => { page.close(); input.value = "/" + c.name + " "; autosize(); input.focus(); };
      body.append(r);
    }
  });
}

// ───────────── files ─────────────
$("#btn-files").onclick = () => openFiles(state.current.cwd);
function openFiles(dir) {
  page.open(shortPath(dir), async body => {
    try {
      const r = await conn.call("fs.list", { path: dir });
      if (r.path !== "/") { const up = h(`<button class="list-row">${icon("back")}<div class="t">..</div></button>`); up.onclick = () => { page.stack.pop(); openFiles(r.parent); }; body.append(up); }
      for (const e of r.entries) {
        if (e.name === ".pocket-agent-uploads") continue;
        const row = h(`<button class="list-row">${icon(e.dir ? "folder" : "file")}<div class="t"></div><div class="m">${e.dir ? "" : fmtSize(e.size)}</div></button>`);
        row.querySelector(".t").textContent = e.name;
        const full = r.path.replace(/\/$/, "") + "/" + e.name;
        row.onclick = () => e.dir ? openFiles(full) : viewFile(full);
        longPress(row, () => menuSheet(e.name, [
          { label: "Mention in message", icon: "search", run: () => { page.close(); insertAtCursor("@" + rel(full) + " "); autosize(); } },
          { label: "Copy path", icon: "copy", run: () => copyText(full) },
          e.dir && { label: "Start new chat here", icon: "plus", run: () => { page.close(); newChat(full); } },
        ]));
        body.append(row);
      }
    } catch (e) { body.innerHTML = `<div class="settings"><p class="note err">${esc(e.message)}</p></div>`; }
  }, `<button class="icon-btn" data-icon="plus" id="pg-newchat" aria-label="New chat here"></button>`);
  $("#pg-newchat").onclick = () => { page.close(); newChat(dir); };
}
const rel = p => { const c = state.current.cwd; return p.startsWith(c + "/") ? p.slice(c.length + 1) : p; };
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }
function viewFile(p) {
  page.open(shortPath(p), async body => {
    try {
      const r = await conn.call("fs.read", { path: p });
      body.className = "viewer";
      if (r.binary) { body.innerHTML = `<div class="settings"><p>Binary file (${fmtSize(r.size)}).</p></div>`; return; }
      if (/\.md$/i.test(p)) { const m = document.createElement("div"); m.className = "md"; setMd(m, r.text); body.append(m); }
      else body.append(codeBlock(r.text, langOf(p)));
      if (r.truncated) body.append(h(`<div class="note">Showing the first 512 KB.</div>`));
    } catch (e) { body.innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
  }, `<button class="icon-btn" data-icon="copy" id="pg-copy" aria-label="Copy path"></button>`);
  $("#pg-copy").onclick = () => copyText(p);
  const pb = $("#page-body"); const restore = () => { pb.className = ""; };
  $("#page-back").addEventListener("click", restore, { once: true });
}
function pickFolder(start) {
  return new Promise(resolve => {
    const recent = [...new Set(state.sessions.map(s => s.cwd).filter(Boolean))].slice(0, 8);
    const b = sheet.open(`<h2>Choose a folder</h2><div class="sub">Claude works inside this folder.</div><div id="pf"></div>
      <div class="btns"><button class="btn" data-a="browse">Browse…</button><button class="btn ghost" data-a="new">New project folder…</button></div>`, { onClose: () => resolve(null) });
    for (const d of recent) { const o = h(`<button class="opt">${icon("folder")}<div class="ot"><div></div><div class="od"></div></div></button>`); o.querySelector(".ot div").textContent = baseName(d); o.querySelector(".od").textContent = shortPath(d); o.onclick = () => { sheet.close(true); resolve(d); }; b.querySelector("#pf").append(o); }
    b.querySelector('[data-a="new"]').onclick = async () => {
      sheet.close(true);
      const name = await promptSheet({ title: "New project folder", placeholder: "my-app", ok: "Create" });
      if (!name) return resolve(null);
      const p = (name.startsWith("/") ? name : state.home + "/projects/" + name.replace(/[^\w.\- ]/g, "-"));
      try { await conn.call("fs.mkdir", { path: p }); resolve(p); } catch (e) { toast(e.message); resolve(null); }
    };
    b.querySelector('[data-a="browse"]').onclick = () => { sheet.close(true); browseFolder(start || state.home, resolve); };
  });
}
function browseFolder(dir, resolve) {
  page.open(shortPath(dir), async body => {
    const r = await conn.call("fs.list", { path: dir }).catch(e => ({ error: e.message }));
    if (r.error) { body.innerHTML = `<p class="note err">${esc(r.error)}</p>`; return; }
    const use = h(`<div class="settings"><button class="btn primary" style="width:100%">Use this folder</button></div>`);
    use.querySelector("button").onclick = () => { page.close(); resolve(r.path); };
    body.append(use);
    if (r.path !== "/") { const up = h(`<button class="list-row">${icon("back")}<div class="t">..</div></button>`); up.onclick = () => { page.stack.pop(); browseFolder(r.parent, resolve); }; body.append(up); }
    for (const e of r.entries.filter(e => e.dir)) {
      const row = h(`<button class="list-row">${icon("folder")}<div class="t"></div></button>`); row.querySelector(".t").textContent = e.name;
      row.onclick = () => { page.stack.pop(); browseFolder(r.path.replace(/\/$/, "") + "/" + e.name, resolve); };
      body.append(row);
    }
  });
}

// ───────────── settings ─────────────
function openSettings() {
  page.open("Settings", body => {
    const d = state.defaults;
    body.innerHTML = `<div class="settings">
      <h3>Appearance</h3>
      <div class="set-row"><div class="l">Theme</div></div><div class="seg" id="s-theme">${["system", "light", "dark"].map(t => `<button data-v="${t}" class="${settings.theme === t ? "on" : ""}">${t}</button>`).join("")}</div>
      <div class="set-row"><div class="l">Text size</div></div><div class="seg" id="s-font">${[14, 15.5, 17, 19].map(t => `<button data-v="${t}" class="${settings.fontSize == t ? "on" : ""}">${t === 14 ? "Small" : t === 15.5 ? "Default" : t === 17 ? "Large" : "Huge"}</button>`).join("")}</div>
      <div class="set-row"><div class="l">Show thinking while Claude works</div><button class="switch ${settings.showThinking ? "on" : ""}" data-k="showThinking"></button></div>
      <div class="set-row"><div class="l">Expand tool details by default</div><button class="switch ${settings.autoExpandTools ? "on" : ""}" data-k="autoExpandTools"></button></div>
      <h3>Input</h3>
      <div class="set-row"><div class="l">Enter sends message<small>Off: Enter adds a new line, tap the arrow to send</small></div><button class="switch ${settings.enterToSend ? "on" : ""}" data-k="enterToSend"></button></div>
      <div class="set-row"><div class="l">Haptic feedback</div><button class="switch ${settings.haptics ? "on" : ""}" data-k="haptics"></button></div>
      <h3>Notifications</h3>
      <div class="set-row"><div class="l">When Claude needs approval<small>With Allow / Deny buttons</small></div><button class="switch ${settings.notifyApproval ? "on" : ""}" data-k="notifyApproval"></button></div>
      <div class="set-row"><div class="l">When Claude finishes</div><button class="switch ${settings.notifyDone ? "on" : ""}" data-k="notifyDone"></button></div>
      <h3>New chat defaults</h3>
      <div class="set-row"><div class="l">Folder<small id="d-cwd">${esc(shortPath(d.cwd) || "~ (home)")}</small></div><button class="chip" id="d-cwd-btn">Change</button></div>
      <div class="set-row"><div class="l">Model<small>${esc(modelLabel(d.model))}</small></div><button class="chip" id="d-model">Change</button></div>
      <div class="set-row"><div class="l">Effort</div></div><div class="seg" id="d-effort">${["", ...EFFORTS].map(e => `<button data-v="${e}" class="${(d.effort || "") === e ? "on" : ""}">${e || "auto"}</button>`).join("")}</div>
      <div class="set-row"><div class="l">Permission mode</div></div><div class="seg" id="d-mode">${MODES.slice(0, 4).map(m => `<button data-v="${m.id}" class="${(d.permissionMode || "default") === m.id ? "on" : ""}">${m.short}</button>`).join("")}</div>
      <h3>Connection</h3>
      <div class="set-row"><div class="l">Server<small>${esc(settings.server || "This phone (Termux)")}</small></div><button class="chip" id="s-server">Change</button></div>
      ${native ? `<div class="set-row"><div class="l">Restart the Termux server</div><button class="chip" id="s-restart">Restart</button></div>` : ""}
      <h3>Account</h3>
      <div class="set-row"><div class="l">${esc(state.account?.email || state.account?.organization || "Claude account")}<small>${esc(state.account?.subscriptionType || state.account?.apiKeySource || "Signed in through Claude Code in Termux")}</small></div></div>
      <h3>About</h3>
      <div class="set-row"><div class="l">Pocket Agent ${esc(nativeCall("appVersion") || "web")}<small>Runs Claude Code locally in Termux</small></div></div>
    </div>`;
    body.querySelectorAll(".switch[data-k]").forEach(sw => sw.onclick = () => { settings[sw.dataset.k] = !settings[sw.dataset.k]; sw.classList.toggle("on"); saveSettings(); });
    seg(body, "#s-theme", v => { settings.theme = v; saveSettings(); });
    seg(body, "#s-font", v => { settings.fontSize = +v; saveSettings(); });
    seg(body, "#d-effort", v => setDefaults({ effort: v || null }));
    seg(body, "#d-mode", v => setDefaults({ permissionMode: v }));
    body.querySelector("#d-cwd-btn").onclick = async () => { const p = await pickFolder(d.cwd); if (p) { await setDefaults({ cwd: p }); body.querySelector("#d-cwd").textContent = shortPath(p); } };
    body.querySelector("#d-model").onclick = () => {
      const b = sheet.open(`<h2>Default model</h2><div id="dm"></div>`);
      for (const m of [{ value: null, displayName: "Claude Code default", description: "Whatever your Claude Code settings use" }, ...state.models]) {
        const o = h(`<button class="opt">${icon("circle")}<div class="ot"><div>${esc(m.displayName)}</div><div class="od">${esc(m.description || "")}</div></div></button>`);
        o.onclick = () => { sheet.close(true); setDefaults({ model: m.value }).then(openSettingsRefresh); };
        b.querySelector("#dm").append(o);
      }
    };
    body.querySelector("#s-server").onclick = async () => {
      const url = await promptSheet({ title: "Server address", value: settings.server, placeholder: "Leave empty for this phone, or http://host:8765" });
      if (url === null) return;
      settings.server = url.replace(/\/$/, "");
      if (url) { const tok = await promptSheet({ title: "Server token", value: settings.token, placeholder: "Run `pocket-agent token` on the server" }); if (tok !== null) settings.token = tok; } else settings.token = "";
      saveSettings(); conn.ws?.close(); toast("Reconnecting…"); openSettingsRefresh();
    };
    body.querySelector("#s-restart")?.addEventListener("click", () => { nativeCall("restartServer"); toast("Restarting server…"); });
  });
}
function openSettingsRefresh() { page.close(); openSettings(); }
function seg(root, sel, fn) { root.querySelectorAll(sel + " button").forEach(b => b.onclick = () => { root.querySelectorAll(sel + " button").forEach(x => x.classList.remove("on")); b.classList.add("on"); fn(b.dataset.v); }); }
async function setDefaults(patch) {
  try { const r = await conn.call("defaults.set", { defaults: patch }); state.defaults = r.defaults; if (state.current?.isNew) { Object.assign(state.current, patch); updateComposer(); } } catch (e) { toast(e.message); }
}

// ───────────── scrolling ─────────────
const chatEl = $("#chat");
let pinned = true;
chatEl.addEventListener("scroll", () => {
  pinned = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  $("#jump").hidden = pinned;
  $("#topbar").classList.toggle("scrolled", chatEl.scrollTop > 4);
}, { passive: true });
function scrollIfPinned() { if (pinned) chatEl.scrollTop = chatEl.scrollHeight; }
function scrollToBottom(force) { if (force) pinned = true; requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; }); }
$("#jump").onclick = () => scrollToBottom(true);
new ResizeObserver(() => scrollIfPinned()).observe($("#composer"));

// ───────────── intents from Android (share sheet, notifications, shortcuts) ─────────────
callbacks.intent = i => { if (!conn.ok) { window.__pendingIntent = i; return; } handleIntent(i); };
async function handleIntent(i) {
  if (!i) return;
  if (i.action === "open" && i.sessionId) { page.close(); sheet.close(true); await openSession(i.sessionId); }
  else if (i.action === "new") { page.close(); newChat(); setTimeout(() => input.focus(), 200); }
  else if (i.action === "voice") { newChat(); nativeCall("startVoice"); }
  else if (i.action === "share") {
    newChat();
    if (i.text) { input.value = i.text; autosize(); }
    for (const f of i.files || []) attachments.push({ kind: /^image\/(png|jpeg|gif|webp)$/.test(f.mediaType) ? "image" : "file", name: f.name, mediaType: f.mediaType, data: f.data });
    renderAttachments(); updateComposer(); input.focus();
  }
}
nativeCall("ready");
