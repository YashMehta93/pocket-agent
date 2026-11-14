// composer.js — message box, attachments, voice, / and @ autocomplete, model/mode pickers, edit & retry
"use strict";



// ───────────── composer ─────────────
function currentSettings() {
  const cur = state.current || {}; const li = state.liveInfo[cur.sessionId];
  return { model: li?.model ?? cur.model ?? state.defaults.model ?? null, effort: li?.effort ?? cur.effort ?? state.defaults.effort ?? null,
    permissionMode: li?.permissionMode ?? cur.permissionMode ?? state.defaults.permissionMode ?? "default" };
}
/** claude-opus-5-5 → "Opus 5.5" (also with a date or [1m] suffix). */
function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id || "");
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "") : (id || "").replace(/^claude-/, "");
}
/** The model's real name, never "Default": the default resolves to the model it stands for. */
function modelLabel(id) {
  if (!id || id === "default") { const def = state.models.find(x => x.value === "default"); if (!def?.resolvedModel) return "Model"; id = def.resolvedModel; }
  const m = state.models.find(x => x.value !== "default" && (x.value === id || x.resolvedModel === id));
  return m ? m.displayName : prettyModel(id);
}
function updateComposer() {
  const s = currentSettings();
  const mode = MODES.find(m => m.id === s.permissionMode) || MODES[0];
  const chipMode = $("#chip-mode"); chipMode.textContent = mode.short; chipMode.classList.toggle("warn", !!mode.warn || mode.id === "auto");
  $("#chip-model").textContent = modelLabel(s.model) + (s.effort ? " · " + s.effort : "");
  const st = sessionState(state.current?.sessionId);
  const running = st === "running" || st === "waiting";
  input.placeholder = running ? "Queue a message…" : "Message Claude…";
  const send = $("#btn-send");
  const hasText = input.value.trim() || attachments.length;
  send.classList.toggle("stop", running && !hasText);
  send.innerHTML = icon(running && !hasText ? "stop" : "up");
  send.disabled = !running && !hasText;
  send.setAttribute("aria-label", running && !hasText ? "Stop" : "Send");
  renderActivity();
  if (typeof renderAgentsLine === "function") renderAgentsLine();
}
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
  try { await conn.call("interrupt", { sessionId: state.current.sessionId }); }
  catch (e) {   // not running any more (e.g. the server restarted): show it as stopped instead of an error
    if (/not (running|live|open)|no live/i.test(e.message)) { delete state.liveInfo[state.current.sessionId]; updateComposer(); toast("Already stopped"); } else toast(e.message);
  }
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
    // A new chat, or one whose process was closed (idle, restart): start it with what the composer shows.
    if (cur.isNew || !state.liveInfo[cur.sessionId]) Object.assign(msg, { model: s.model || undefined, effort: s.effort || undefined, permissionMode: s.permissionMode });
    if (cur.isNew) msg.cwd = cur.cwd;
    if (cur.isNew) { cur.isNew = false; cur.title = text.slice(0, 60); updateHeader(); }
    await conn.call("send", msg);
    scrollToBottom(true);
    debouncedRefresh();
  } catch (e) {
    if (e.code === "BUSY_ELSEWHERE") return busySheet(e, text, images);
    toast(e.message); chat.note("Couldn't send: " + e.message, true);
  }
}

// The chat is open in another Claude Code process (a terminal or background session): ask how to continue.
function busySheet(e, text, images) {
  const cur = state.current;
  const bg = e.kind === "background";
  // In the built-in Linux that other process runs inside the app; only the Termux server lives in Termux.
  const inTermux = native && nativeCall("isStandalone") !== true;
  const where = inTermux ? "in Termux" : "elsewhere";
  const b = sheet.open(`<h2>This chat is open ${where}</h2>
    <div class="sub">${esc(e.message)} Claude Code can only run a chat in one place at a time. Your message is kept.</div>
    <div class="btns">
      <button class="btn primary" data-a="fork">Continue in a copy</button>
      ${bg ? `<button class="btn" data-a="stop">Stop it there and continue here</button>` : ""}
      ${inTermux ? `<button class="btn ghost" data-a="termux">${bg ? "Open it in Termux" : "Go to Termux"}</button>` : ""}
      <button class="btn ghost" data-a="cancel">Cancel</button>
    </div>`, { onClose: () => restoreDraft(text) });
  const go = async mode => {
    sheet.close(true);
    try {
      const r = await conn.call("session.continueHere", { sessionId: cur.sessionId, mode });
      if (mode === "fork") { await refreshSessions(); await openSession(r.sessionId); toast("Continuing in a copy"); }
      else toast("Stopped " + where);
      await send(text);
    } catch (err) { toast(err.message); restoreDraft(text); }
  };
  b.querySelector('[data-a="fork"]').onclick = () => go("fork");
  b.querySelector('[data-a="stop"]')?.addEventListener("click", async () => {
    if (await confirmSheet({ title: "Stop the other copy?", text: "Whatever Claude is doing in that background session stops. Its history is kept.", ok: "Stop it", danger: true })) go("stop");
    else restoreDraft(text);
  });
  b.querySelector('[data-a="termux"]')?.addEventListener("click", () => {
    sheet.close(true); restoreDraft(text);
    if (bg) nativeCall("openInTermux", cur.cwd, ""); else nativeCall("openTermux");
    if (bg) toast(`In Termux run: claude attach ${e.short}`, 4000);
  });
  b.querySelector('[data-a="cancel"]').onclick = () => { sheet.close(true); restoreDraft(text); };
}
function restoreDraft(text) { if (text && !input.value) { input.value = text; autosize(); } }

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
  // no model chosen = the default; an open chat reports the resolved id (claude-…), which ticks its named entry
  const curVal = cur.model || "default", exact = models.some(m => m.value === curVal);
  for (const m of models) {
    const on = m.value === curVal || (!exact && m.value !== "default" && m.resolvedModel === curVal) || (!state.models.length && !m.value);
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
  // Running chats change at once; closed ones are remembered by the server for when they reopen.
  if (!cur.isNew) {
    try { const r = await conn.call("set", { sessionId: cur.sessionId, ...patch }); if (r.info) state.liveInfo[cur.sessionId] = r.info; } catch (e) { toast(e.message); }
  }
  updateComposer();
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
