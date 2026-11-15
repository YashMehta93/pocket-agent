// environments.js — other Pocket Agent servers ("environments", for example a laptop) in the app: Settings →
// Environments (a state dot per device, rename, test, reconnect, pair again, remove), adding one with a pairing
// code, the drawer's Phone / device filter, the device's chip on its chats, the offline notice in a chat, and the
// "Where" row on a new chat (its chats run there; the folder picker browses that machine).
// The server owns the connections, tokens and proxying (server/src/upstreams.js); this file only shows and picks.
"use strict";

state.environments = [];   // other servers: { id, name, url, profile, state, version, protocol, error, lastOnlineAt }
state.profiles = [];       // for the Add sheet's Profile select, when the server knows two or more
state.envFilter = "";      // the drawer's filter: "" = all, "phone" = this phone, else an environment id
try { state.envFilter = localStorage.getItem("pa.envFilter") || ""; } catch {}

const ENV_STATE_TEXT = { connecting: "Connecting…", offline: "Offline", outdated: "Outdated", unauthorized: "Pair again" };
const envById = id => (state.environments || []).find(e => e.id === id) || null;
/** "<envId>:<chatId>" → "<envId>"; a local chat id is a UUID and has no colon. */
function envIdOf(sessionId) { const s = String(sessionId || ""); const i = s.indexOf(":"); return i > 0 ? s.slice(0, i) : null; }
function currentEnvId() { return envIdOf(state.current?.sessionId); }
/** The environment a chat runs on, as it is now (or null for a chat on this phone). */
function sessionEnvironment(sessionId) {
  const id = envIdOf(sessionId);
  if (!id) return null;
  const env = envById(id);
  const rec = (state.sessions || []).find(s => s.sessionId === sessionId);
  const st = env?.state || (rec ? (rec.offline ? "offline" : "online") : "offline");
  return { id, name: env?.name || rec?.environmentName || id, state: st, offline: st !== "online" };
}
/** An environment's name in a chat row: 12 characters at most, with an ellipsis. */
const envShort = (name, max = 12) => { const s = String(name || ""); return s.length > max ? s.slice(0, max - 1) + "…" : s; };
const envHost = url => String(url || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
/** "Online", or why it isn't: the server's error ("Can't reach …", "Pair this device again"). */
function envStateText(env) {
  if (env.state === "online") return "Online";
  return env.error || ENV_STATE_TEXT[env.state] || "Offline";
}
/** "Online · v1.3.0 · 100.64.1.2:8765". */
function envMeta(env) { return [envStateText(env), env.version ? "v" + env.version : "", envHost(env.url)].filter(Boolean).join(" · "); }
function environmentsSummary() {
  const list = state.environments || [];
  if (!list.length) return "None";
  return `${list.length} · ${list.filter(e => e.state === "online").length} online`;
}

// ───────────── from the server (hello, and the "environments" event) ─────────────
function environmentsHello(hello) {
  state.environments = hello.environments || [];
  state.profiles = hello.profiles || [];
  if (state.envFilter && state.envFilter !== "phone" && !envById(state.envFilter)) saveEnvFilter("");
  environmentsUiChanged();
}
conn.on("environments", m => { if (Array.isArray(m.environments)) environmentsChanged(m.environments); });
function environmentsChanged(list) {
  state.environments = list;
  if (state.envFilter && state.envFilter !== "phone" && !envById(state.envFilter)) saveEnvFilter("");
  environmentsUiChanged();
}
function saveEnvFilter(v) {
  state.envFilter = v;
  try { localStorage.setItem("pa.envFilter", v); } catch {}
}
/** Everything on screen that shows an environment: the drawer's filter, its chats, the header and the settings page. */
function environmentsUiChanged() {
  renderEnvFilters();
  const small = document.querySelector('#set-home [data-sec="environments"] small');
  if (small) small.textContent = environmentsSummary();
  if (page.isOpen && $("#page-title").textContent === "Environments") openSettingsRefresh();
  if (state.current?.isNew && typeof renderNewChatWhere === "function") renderNewChatWhere();
  renderSessions();
  updateHeader();
  updateComposer();
}
function putEnvironment(rec) {
  if (!rec?.id) return;
  const list = state.environments || [];
  const i = list.findIndex(e => e.id === rec.id);
  if (i >= 0) state.environments = [...list.slice(0, i), rec, ...list.slice(i + 1)];
  else state.environments = [...list, rec];
  environmentsUiChanged();
}

// ───────────── the drawer's filter: All · Phone · each environment ─────────────
function renderEnvFilters() {
  const box = $("#env-filters"); if (!box) return;
  const envs = state.environments || [];
  box.hidden = !envs.length;
  if (!envs.length) { box.innerHTML = ""; return; }
  const opts = [["", "All"], ["phone", "Phone"], ...envs.map(e => [e.id, e.name])];
  if (!opts.some(([v]) => v === state.envFilter)) state.envFilter = "";
  box.innerHTML = "";
  for (const [v, label] of opts) {
    const b = h(`<button class="${state.envFilter === v ? "on" : ""}"></button>`);
    b.textContent = label;
    b.onclick = () => setEnvFilter(v);
    box.append(b);
  }
}
function setEnvFilter(v) {
  saveEnvFilter(v || "");
  renderEnvFilters();
  renderSessions();
}
/** A chat list's items, filtered by the drawer's All / Phone / environment chips. */
function envFilterMatches(s) {
  if (!state.envFilter) return true;
  const id = s.environment || envIdOf(s.sessionId);
  return state.envFilter === "phone" ? !id : id === state.envFilter;
}

// ───────────── new chat: where it runs ─────────────
/** The row shows only when a device is online: Phone, then every device (offline ones not tappable). */
function renderNewChatWhere() {
  const box = $("#new-where"); if (!box) return;
  const envs = state.environments || [];
  if (!state.current?.isNew || !envs.some(e => e.state === "online")) { box.hidden = true; box.innerHTML = ""; return; }
  const cur = currentEnvId() || "";
  box.hidden = false;
  box.innerHTML = `<span class="where-l">Where</span>`;
  const chip = (id, label, on) => {
    const b = h(`<button></button>`);
    b.textContent = label;
    b.disabled = !on;
    b.classList.toggle("on", cur === id);
    if (on) b.onclick = () => chooseNewChatEnv(id || null);
    box.append(b);
  };
  chip("", "Phone", true);
  for (const e of envs) chip(e.id, e.name, e.state === "online");
}
/** A new chat on a device: its id is "<envId>:<uuid>", and it starts in that machine's home. */
async function chooseNewChatEnv(id) {
  const cur = state.current;
  if (!cur?.isNew) return;
  const env = id ? envById(id) : null;
  if (id && (!env || env.state !== "online")) return;
  cur.sessionId = (id ? id + ":" : "") + uuid();
  cur.cwd = env ? (env.home || "") : (state.defaults.cwd || state.home);
  showEmpty(); updateHeader(); updateComposer();
  // The remote hello's home isn't always sent: asking for its home folder tells us where it starts.
  if (env && !env.home) {
    try {
      const r = await conn.call("fs.list", { env: id });
      if (state.current === cur && currentEnvId() === id && r?.path) { cur.cwd = r.path; showEmpty(); updateHeader(); }
    } catch {}
  }
}

// ───────────── the chat's own state ─────────────
/** "<name> is offline. The chat comes back when it's on." above the message box; sending is off meanwhile. */
function renderEnvNotice() {
  const el = $("#env-offline"); if (!el) return;
  const env = sessionEnvironment(state.current?.sessionId);
  const off = !!env && env.offline;
  el.hidden = !off;
  if (!off) { el.innerHTML = ""; return; }
  el.innerHTML = `${icon("info")}<span></span>`;
  el.querySelector("span").textContent = `${env.name} is offline. The chat comes back when it's on.`;
}

// ───────────── Settings → Environments ─────────────
function environmentsSettingsSection() {
  const list = state.environments || [];
  return {
    id: "environments", title: "Environments", icon: "wifi",
    summary: environmentsSummary(),
    html: () => list.map(envRow).join("")
      + item(`<button class="set-row env-add" id="env-add"><div class="l">Add environment</div></button>`, "environments add another computer laptop server device pair"),
  };
}
function envRow(env) {
  return item(`<button class="set-row env-row" data-env="${esc(env.id)}"><span class="dot ${esc(env.state)}" aria-hidden="true"></span><div class="l">${esc(env.name)}<small>${esc(envMeta(env))}</small></div></button>`,
    `environment ${env.name} ${env.state} ${envHost(env.url)}`);
}
function wireEnvironmentsSettings(root) {
  root.querySelectorAll("[data-env]").forEach(b => b.onclick = () => { const env = envById(b.dataset.env); if (env) environmentSheet(env); });
  root.querySelector("#env-add")?.addEventListener("click", addEnvironmentSheet);
}

/** One environment's sheet: what to do with it, with the test's answer inline. */
function environmentSheet(env) {
  const b = sheet.open(`<h2>${esc(env.name)}</h2><div class="sub">${esc(envMeta(env))}</div>
    <div>
      <button class="menu-item" data-a="rename">${icon("edit")}<span>Rename</span></button>
      <button class="menu-item" data-a="test">${icon("wifi")}<span>Test connection</span></button>
      <button class="menu-item" data-a="reconnect">${icon("retry")}<span>Reconnect</span></button>
      <button class="menu-item" data-a="pair">${icon("key")}<span>Pair again</span></button>
      <button class="menu-item danger" data-a="remove">${icon("trash")}<span>Remove</span></button>
    </div>
    <p class="env-test" id="env-test-res" role="status" hidden></p>`, { key: "environment:" + env.id });
  b.querySelector('[data-a="rename"]').onclick = () => renameEnvironment(env);
  b.querySelector('[data-a="test"]').onclick = () => testEnvironment(env, b.querySelector("#env-test-res"));
  b.querySelector('[data-a="reconnect"]').onclick = () => reconnectEnvironment(env);
  b.querySelector('[data-a="pair"]').onclick = () => pairEnvironmentAgain(env);
  b.querySelector('[data-a="remove"]').onclick = () => removeEnvironmentPrompt(env);
}
async function testEnvironment(env, res) {
  if (!res) return;
  res.hidden = false; res.className = "env-test"; res.textContent = "Testing…";
  let r;
  try { r = await conn.call("environments.test", { url: env.url }); } catch (e) { r = { ok: false, error: e.message }; }
  if (r.ok) { res.className = "env-test"; res.textContent = `OK · ${r.ms} ms${r.version ? " · v" + r.version : ""}`; }
  else { res.className = "env-test err"; res.textContent = r.error || "Can't reach " + envHost(env.url); }
}
async function renameEnvironment(env) {
  const name = await promptSheet({ title: "Rename environment", value: env.name });
  if (name === null) return;
  try { putEnvironment((await conn.call("environments.rename", { environment: env.id, name })).environment); }
  catch (e) { return toast(e.message, 4000); }
  sheet.close(true);
  toast("Renamed");
}
async function reconnectEnvironment(env) {
  try { putEnvironment((await conn.call("environments.reconnect", { environment: env.id })).environment); }
  catch (e) { return toast(e.message, 4000); }
  sheet.close(true);
  toast("Reconnecting…");
}
/** A new pairing code from the other computer: the old token is replaced under the same name. */
async function pairEnvironmentAgain(env) {
  const code = await promptSheet({ title: `Pair with ${env.name} again`, placeholder: "ABCD-EFGH", ok: "Pair" });
  if (!code) return;
  try { putEnvironment((await conn.call("environments.add", { url: env.url, code: code.toUpperCase(), profile: env.profile, name: env.name })).environment); }
  catch (e) { return toast(e.message, 5000); }
  sheet.close(true);
  toast("Paired");
}
async function removeEnvironmentPrompt(env) {
  if (!await confirmSheet({ title: `Remove ${env.name}?`, text: "Its chats leave your list. They stay on that device.", ok: "Remove", danger: true })) return;
  try { await conn.call("environments.remove", { environment: env.id }); }
  catch (e) { return toast(e.message, 4000); }
  state.environments = (state.environments || []).filter(e => e.id !== env.id);
  if (state.envFilter === env.id) saveEnvFilter("");
  environmentsUiChanged();
  toast("Removed");
}

/** Add a device: its address, a pairing code from it, and (when there are several) which profile to pair into. */
function addEnvironmentSheet() {
  const profiles = profileList();
  const b = sheet.open(`<h2>Add environment</h2>
    <p class="env-err" id="env-err" role="alert" hidden></p>
    <div class="env-addr"><input class="field" id="env-url" placeholder="100.101.102.103:8765" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Address"><button class="chip" id="env-test">Test</button></div>
    <p class="env-test" id="env-test-res" role="status" hidden></p>
    <input class="field" id="env-code" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Pair code">
    <div class="set-foot">Get a code on the other computer: <code>node server/src/pair-cli.js</code></div>
    ${profiles.length >= 2 ? `<div class="set-row"><div class="l">Profile</div></div><select class="field" id="env-profile" aria-label="Profile">${profiles.map(p => `<option value="${esc(p.id)}"${p.id === "personal" ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>` : ""}
    <div class="btns row2"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" id="env-add-btn">Add</button></div>`,
  { key: "env-add" });
  const url = b.querySelector("#env-url"), code = b.querySelector("#env-code"), err = b.querySelector("#env-err"),
    res = b.querySelector("#env-test-res"), test = b.querySelector("#env-test"), add = b.querySelector("#env-add-btn"),
    profile = b.querySelector("#env-profile");
  setTimeout(() => url.focus(), 250);
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  url.oninput = () => { err.hidden = true; res.hidden = true; };
  // A code is shown in capitals: uppercase it as it's typed, keeping the caret where it was.
  code.oninput = () => {
    const up = code.value.toUpperCase();
    if (code.value === up) return;
    const at = code.selectionStart;
    code.value = up;
    try { code.selectionStart = code.selectionEnd = at; } catch {}
  };
  test.onclick = async () => {
    const u = url.value.trim();
    res.hidden = true; err.hidden = true;
    if (!u) return fail("Give the other computer's address");
    test.disabled = true; res.hidden = false; res.className = "env-test"; res.textContent = "Testing…";
    let r;
    try { r = await conn.call("environments.test", { url: u }); } catch (e) { r = { ok: false, error: e.message }; }
    test.disabled = false;
    if (r.ok) { res.className = "env-test"; res.textContent = `OK · ${r.ms} ms${r.version ? " · v" + r.version : ""}`; }
    else { res.className = "env-test err"; res.textContent = r.error || "Can't reach " + envHost(u); }
  };
  add.onclick = async () => {
    const u = url.value.trim(), c = code.value.trim();
    err.hidden = true;
    if (!u) return fail("Give the other computer's address");
    if (!c) return fail("Paste the pairing code from the other computer");
    add.disabled = true; add.textContent = "Adding…";
    let r;
    try { r = await conn.call("environments.add", { url: u, code: c, ...(profile ? { profile: profile.value } : {}) }); }
    catch (e) { add.disabled = false; add.textContent = "Add"; return fail(e.message); }
    sheet.close(true);
    if (r.environment) putEnvironment(r.environment);
    toast("Added " + (r.environment?.name || "environment"));
  };
  b.querySelector('[data-a="cancel"]').onclick = () => sheet.close(true);
}
function profileList() {
  return (state.profiles || [])
    .map(p => typeof p === "string" ? { id: p, name: p } : { id: p.id ?? p.name, name: p.name ?? p.id })
    .filter(p => p.id);
}
