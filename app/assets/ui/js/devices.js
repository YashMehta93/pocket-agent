// devices.js — Settings → Devices: other devices that may use this server with their own token and scopes,
// each renameable and revocable, plus a one-use pair code with a countdown. A device can also be limited to
// folders ("roots", #72): it then sees and reaches nothing outside them. The server owns tokens, codes, roots
// and the checks (server/src/devices.js, server/src/roots.js); this file only shows them and asks.
"use strict";

state.devices = [];   // [{ id, name, scopes, roots, createdAt, lastSeenAt }] from devices.list
let pairTimer = null; // the countdown under an open pair code

/** The Settings row's summary: how many devices are paired, or the pairing hint when there are none. */
function devicesSummary() {
  const n = (state.devices || []).length;
  return n === 1 ? "1 device" : n ? `${n} devices` : "Pair another device with a code";
}
/** Settings → Devices: a row on the Settings home, opening a short page of its own (like the other categories). */
function devicesSettingsSection() {
  return {
    id: "devices", title: "Devices", icon: "wifi",
    summary: devicesSummary(),
    html: () => item(`<div id="dev-list"><p class="note">Loading…</p></div>
      <div id="dev-pair"></div>
      <div id="dev-pair-btn-box" style="margin-top:14px"></div>`, "devices paired pair another phone hub computer token folders"),
  };
}
/** Loads the count when Settings opens: another device can have paired since this app last looked. */
let deviceCountAsk = 0;
async function loadDeviceCount() {
  const ask = ++deviceCountAsk;
  let r;
  try { r = await conn.call("devices.list"); }
  catch { return; }
  if (ask !== deviceCountAsk) return;   // a newer look already answered: its count is the current one
  state.devices = r.devices || [];
  const el = document.querySelector('[data-sec="devices"] .t small');
  if (el) el.textContent = devicesSummary();
}
/** Hooks up the section above (wireSettings calls this for the page and for search results). */
function wireDevicesSettings(root) {
  if (root.querySelector("#dev-list")) renderDevices(root);
  if (root.querySelector("#dev-pair-btn-box")) renderPairButton(root);
}

async function renderDevices(root) {
  const box = root.querySelector("#dev-list");
  if (!box) return;
  let r;
  try { r = await conn.call("devices.list"); }
  catch (e) { box.innerHTML = `<p class="note err">${esc(e.message)}</p>`; return; }
  state.devices = r.devices || [];
  if (!state.devices.length) { box.innerHTML = `<p class="note">No devices paired yet.</p>`; return; }
  box.innerHTML = state.devices.map(deviceRow).join("");
  box.querySelectorAll("[data-dev-open]").forEach(el => el.onclick = () => openDeviceSheet(root, el.dataset.devOpen));
  box.querySelectorAll("[data-dev]").forEach(b => b.onclick = () => deviceAction(root, b.dataset.dev, b.dataset.act));
}

/** " · limited to 2 folders", or nothing when it has no limit. */
function deviceRootsNote(d) {
  const n = (d.roots || []).length;
  return n ? ` · limited to ${n} folder${n === 1 ? "" : "s"}` : "";
}

function deviceRow(d) {
  const used = d.lastSeenAt ? "last used " + deviceAgo(d.lastSeenAt) : "never used";
  return `<div class="set-row"><div class="l" data-dev-open="${esc(d.id)}" style="cursor:pointer">${esc(d.name)}<small class="dev-scopes">${esc((d.scopes || []).join(", "))}${esc(deviceRootsNote(d))}</small><small class="dev-used">${esc(used)}</small></div>
    <div class="acc-chips"><button class="chip" data-dev="${esc(d.id)}" data-act="rename">Rename</button><button class="chip danger" data-dev="${esc(d.id)}" data-act="revoke">Revoke</button></div></div>`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
function deviceAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/** One device's sheet: rename it, change the folders it may reach, or revoke it (#72). */
function openDeviceSheet(root, id) {
  const d = state.devices.find(x => x.id === id);
  if (!d) return;
  const used = d.lastSeenAt ? "last used " + deviceAgo(d.lastSeenAt) : "never used";
  const b = sheet.open(`<h2>${esc(d.name)}</h2><div class="sub">${esc((d.scopes || []).join(", "))}${esc(deviceRootsNote(d))}<br>${esc(used)}</div>
    <div>
      <button class="menu-item" data-a="rename">${icon("edit")}<span>Rename</span></button>
      <button class="menu-item" data-a="folders">${icon("folder")}<span>Change folders</span></button>
      <button class="menu-item danger" data-a="revoke">${icon("trash")}<span>Revoke</span></button>
    </div>`);
  b.querySelector('[data-a="rename"]').onclick = () => { sheet.close(true); renameDeviceFromUi(root, d); };
  b.querySelector('[data-a="folders"]').onclick = () => { sheet.close(true); openDeviceFolders(root, d); };
  b.querySelector('[data-a="revoke"]').onclick = () => { sheet.close(true); revokeDeviceFromUi(root, d); };
}

async function deviceAction(root, id, act) {
  const d = state.devices.find(x => x.id === id);
  if (!d) return;
  if (act === "rename") return renameDeviceFromUi(root, d);
  if (act === "revoke") return revokeDeviceFromUi(root, d);
}

async function renameDeviceFromUi(root, d) {
  const name = await promptSheet({ title: "Rename device", value: d.name });
  if (name === null) return;
  try { await conn.call("devices.rename", { device: d.id, name }); }
  catch (e) { return toast(e.message, 4000); }
  toast("Renamed");
  return renderDevices(root);
}

async function revokeDeviceFromUi(root, d) {
  if (!await confirmSheet({ title: "Revoke " + d.name + "?", text: "Its token stops working right away and any open connection closes. Pair it again with a new code to allow it.", ok: "Revoke", danger: true })) return;
  try { await conn.call("devices.revoke", { device: d.id }); }
  catch (e) { return toast(e.message, 4000); }
  toast("Revoked");
  return renderDevices(root);
}

// ───────────── the folders a device is limited to (#72) ─────────────
/** A small editable list with a × per folder, as in the profiles editor; an empty list means no limit. */
function renderDeviceRoots(box, draft, rerender) {
  box.innerHTML = "";
  if (!draft.length) { box.innerHTML = `<div class="pf-none">No folder limit.</div>`; return; }
  for (const w of draft) {
    const row = h(`<div class="set-row pf-folder"><div class="l"></div><button type="button" class="pf-x" aria-label="Remove folder" data-icon="x"></button></div>`);
    row.querySelector(".l").textContent = shortPath(w);
    row.querySelector(".pf-x").onclick = () => { draft.splice(draft.indexOf(w), 1); rerender(); };
    box.append(row);
  }
}
/** The "Add folder" button: the app's folder picker on this server, without anything already chosen. */
async function addRootFromPicker(draft, rerender) {
  const p = await pickFolder(draft[0] || state.current?.cwd);
  if (!p || draft.includes(p)) return;
  draft.push(p);
  rerender();
}

// ───────────── pairing ─────────────
function renderPairButton(root) {
  const box = root.querySelector("#dev-pair-btn-box");
  if (!box) return;
  box.innerHTML = `<button class="btn primary" id="dev-pair-btn" style="width:100%">Pair a device</button>`;
  box.querySelector("#dev-pair-btn").onclick = () => openPairSheet(root);
}

/** Pair a device: optionally limit it to folders first, then make a one-use code. */
function openPairSheet(root, initialRoots = []) {
  clearPairTimer();
  const draft = [...initialRoots];
  const b = sheet.open(`<h2>Pair a device</h2><div class="sub">It gets its own token. You can limit it to folders.</div>
    <h3>Limit to folders</h3>
    <div id="dev-folders"></div>
    <button type="button" class="prof-new" id="dev-add-folder">Add folder</button>
    <p class="pf-err" id="dev-pair-err" role="alert" hidden></p>
    <div class="btns"><button class="btn primary" id="dev-pair-go">Make a code</button></div>`);
  const list = b.querySelector("#dev-folders");
  const rerender = () => renderDeviceRoots(list, draft, rerender);
  rerender();
  b.querySelector("#dev-add-folder").onclick = () => addRootFromPicker(draft, rerender);
  const err = b.querySelector("#dev-pair-err"), go = b.querySelector("#dev-pair-go");
  go.onclick = async () => {
    err.hidden = true;
    go.disabled = true; go.textContent = "Making a code…";
    let r;
    try { r = await conn.call("devices.pair", { roots: draft }); }
    catch (e) { go.disabled = false; go.textContent = "Make a code"; err.textContent = e.message; err.hidden = false; return; }
    showPairCode(root, r);
  };
}

/** The code and its countdown (it replaces the pairing sheet's contents). While the code is good it is the only
 *  action; once it expires, a "New code" button appears. */
function showPairCode(root, r) {
  clearPairTimer();
  const box = $("#sheet-body");
  box.innerHTML = `<h2>Pair a device</h2><div class="pair-code" id="pair-code"></div>
    <div class="pair-exp" id="pair-exp"></div>
    <p class="note" style="text-align:center">Enter this code on the other device. It works once.</p>
    <div class="btns"><button class="btn primary" id="dev-pair-new" hidden>New code</button></div>`;
  box.querySelector("#pair-code").textContent = r.code;
  const exp = box.querySelector("#pair-exp"), again = box.querySelector("#dev-pair-new");
  const tick = () => {
    if (!document.contains(box)) return clearPairTimer();   // the page closed or re-rendered
    const left = Math.max(0, r.expiresAt - Date.now());
    if (left <= 0) { exp.textContent = "This code has expired."; again.hidden = false; return clearPairTimer(); }
    exp.textContent = `Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
    again.hidden = true;
  };
  tick();
  pairTimer = setInterval(tick, 1000);
  again.onclick = () => openPairSheet(root, Array.isArray(r.roots) ? r.roots : []);
}
function clearPairTimer() { if (pairTimer) { clearInterval(pairTimer); pairTimer = null; } }

// ───────────── changing a paired device's folders ─────────────
function openDeviceFolders(root, d) {
  const draft = [...(d.roots || [])];
  const b = sheet.open(`<h2>Folders for ${esc(d.name)}</h2><div class="sub">It sees only chats and files in these folders. No folders means no limit.</div>
    <div id="df-list"></div>
    <button type="button" class="prof-new" id="df-add">Add folder</button>
    <p class="pf-err" id="df-err" role="alert" hidden></p>
    <div class="btns"><button class="btn primary" id="df-save">Save</button></div>`);
  const list = b.querySelector("#df-list");
  const rerender = () => renderDeviceRoots(list, draft, rerender);
  rerender();
  b.querySelector("#df-add").onclick = () => addRootFromPicker(draft, rerender);
  const err = b.querySelector("#df-err"), save = b.querySelector("#df-save");
  save.onclick = async () => {
    err.hidden = true;
    save.disabled = true; save.textContent = "Saving…";
    let r;
    try { r = await conn.call("devices.setRoots", { device: d.id, roots: draft }); }
    catch (e) { save.disabled = false; save.textContent = "Save"; err.textContent = e.message; err.hidden = false; return; }
    state.devices = state.devices.map(x => x.id === d.id ? r.device : x);
    sheet.close(true);
    toast("Saved");
    renderDevices(root);
  };
}
