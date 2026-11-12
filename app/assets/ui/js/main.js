// main.js — app start-up: connection lifecycle, server events, scrolling, Android intents (loaded last)
"use strict";



// ───────────── boot ─────────────
hydrateIcons();
applySettings();
conn.on("open", onConnected);
conn.on("close", () => showBanner(state.updating ? "Installing the update… back in a few seconds." : "Connection lost. Reconnecting…"));
conn.on("retrying", async n => {
  if (n < 3) return;
  const standalone = native && nativeCall("isStandalone") === true;
  if (await conn.probe() === "up") showBanner("The server is running but this app isn't paired with it yet.", "Pair", pairServer);
  // The built-in server is restarted by the app itself; there's nothing for the user to open.
  else if (standalone) showBanner(state.updating ? "Installing the update… back in a few seconds." : "Restarting Pocket Agent's server…");
  else showBanner(native ?"Starting the Claude server in Termux… If this takes long, open Termux and run: pocket-agent start" : "Can't reach the server.", native ? "Open Termux" : null, () => nativeCall("openTermux"));
});
async function pairServer() {
  const tok = await promptSheet({ title: "Pair with the server", placeholder: "Paste the token here", ok: "Pair",
    value: "" });
  if (!tok) return;
  settings.token = tok.trim(); saveSettings();
  conn.ws?.close(); conn.connect(); toast("Pairing…");
}

async function onConnected() {
  hideBanner();
  const hello = await conn.call("hello");
  // The server serves the UI; if its files changed since this page loaded, reload to pick them up.
  if (window.__uiVersion && hello.uiVersion && hello.uiVersion !== window.__uiVersion && !Object.values(hello.live || {}).some(i => i.state === "running")) { location.reload(); return; }
  window.__uiVersion = hello.uiVersion;
  Object.assign(state, { home: hello.home, hostName: hello.host, defaults: hello.defaults || {}, pinned: hello.pinned || [],
    commands: hello.commands || [], models: hello.models || [], account: hello.account });
  for (const i of hello.live || []) { state.liveInfo[i.sessionId] = i; if (i.activity) state.activity[i.sessionId] = i.activity; }
  state.pending = (hello.live || []).flatMap(i => i.pending || []);
  const where = hello.mode === "standalone" ? "This phone" : settings.server ? settings.server.replace(/^https?:\/\//, "") : hello.host;
  $("#conn-foot").innerHTML = `${icon("wifi")}<span>${esc(where)} · server ${esc(hello.version)}</span>`;
  await refreshSessions();
  const cur = state.current;
  if (cur && !cur.isNew) await openSession(cur.sessionId, { keepScroll: true });
  else updateHeader();
  updateComposer();
  if (window.__pendingIntent) { const i = window.__pendingIntent; window.__pendingIntent = null; handleIntent(i); }
  Object.assign(state, { updateChannel: hello.updateChannel || null, updateKind: hello.updateKind || null, githubToken: !!hello.githubToken, defaultRepo: hello.defaultRepo || "", devRepo: hello.devRepo || null, updateTrack: hello.updateTrack || { track: "stable" } });
  askBatteryOnce();
  // An app update brings the matching code too: offer only that, one banner, one tap.
  checkAppUpdate().then(shown => { if (!shown && state.updateChannel) checkServerUpdate(false); });
}

/** If the server has a newer APK than the one installed, offer a one-tap update. */
async function checkAppUpdate() {
  if (!native) return false;
  try {
    const u = await conn.call("app.update");
    const have = nativeCall("appVersionCode") || 0;
    if (!u.versionCode || u.versionCode <= have) return false;
    // Android installs an update only if it's signed with the same key as the installed app.
    const mine = u.signer ? (await nativeRpc("capabilities").catch(() => ({}))).signer : null;
    if (u.signer && mine && u.signer !== mine) {
      showBanner(`v${u.versionName} is signed with a different key`, "Why", explainSigner);
      return false;   // can't install it: the code update still applies
    }
    showBanner(`App update available (v${u.versionName})`, "Update", () => installAppUpdate(u.url));
    return true;
  } catch { return false; }
}
/** Android stops background apps to save power, which cuts off Claude mid-reply. Ask once to be exempt. */
async function askBatteryOnce() {
  if (!native || settings.batteryAsked || nativeCall("isStandalone") !== true) return;
  const p = await nativeRpc("permissions.check", { names: [] }).catch(() => null);
  if (!p || p.battery !== false || !$("#banner").hidden) return;
  showBanner("Let Pocket Agent keep running in the background, so Android doesn't stop Claude mid-reply.", "Allow", () => {
    settings.batteryAsked = true; saveSettings(); hideBanner();
    nativeRpc("battery.request").catch(e => toast(e.message));
  });
}
function explainSigner() {
  sheet.open(`<h3>This build can't update your app</h3>
    <p>Android only installs an update signed with the same key as the app you have. Your update source built this APK with its own key, for example your own build of Pocket Agent while the app came from the official release.</p>
    <p>Changes to the screens and the server still update instantly (Settings → Check for updates). Only changes to the Java code need the APK.</p>
    <p>To switch to your own build: Settings → <b>Back up to phone storage</b>, uninstall Pocket Agent, install <code>build/pocket-agent.apk</code> (copied to Download/claude apps by every build), set it up, then Settings → <b>Restore a backup</b>. From then on your own builds update it in one tap. See CONTRIBUTING.md, "Your own version".</p>`);
}
async function installAppUpdate(url) {
  // Old apps (before v0.1.6) can't install updates themselves; point them to the file.
  if (typeof native.rpc !== "function") { toast("Install pocket-agent.apk from Downloads/claude apps once; after that, updates are one tap.", 6000); return; }
  toast("Downloading update…");
  try { await nativeRpc("update.install", { url: url || "/apk/download" }); hideBanner(); }
  catch (e) { toast(e.message, 5000); }
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
conn.on("activity", m => {
  state.activity[m.sessionId] = m.activity;
  if (state.current?.sessionId === m.sessionId) renderActivity();
});
conn.on("meta", m => { state.commands = m.commands || state.commands; state.models = m.models || state.models; state.account = m.account || state.account; updateComposer(); });
conn.on("sessions.changed", () => debouncedRefresh());
const debouncedRefresh = debounce(refreshSessions, 400);

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
// Live messages fade in (css .enter); history loads without animation.
new MutationObserver(muts => {
  if (chat.loadingHistory) return;
  for (const mu of muts) for (const n of mu.addedNodes) if (n.nodeType === 1) n.classList.add("enter");
}).observe($("#messages"), { childList: true });

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

// ───────────── start ─────────────
conn.connect();
newChat();
nativeCall("ready");
