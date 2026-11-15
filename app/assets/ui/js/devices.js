// devices.js — Settings → Devices: other devices that may use this server with their own token and scopes,
// each renameable and revocable, plus a one-use pair code with a countdown. The server owns tokens and
// codes (server/src/devices.js); this file only shows them and asks for new ones.
"use strict";

state.devices = [];   // [{ id, name, scopes, createdAt, lastSeenAt }] from devices.list
let pairTimer = null; // the countdown under an open pair code

/** Settings → Devices: a row on the Settings home, opening a short page of its own (like the other categories). */
function devicesSettingsSection() {
  const n = (state.devices || []).length;
  return {
    id: "devices", title: "Devices", icon: "wifi",
    summary: n ? `${n} paired · pair another` : "Pair another device with a code",
    html: () => item(`<div id="dev-list"><p class="note">Loading…</p></div>
      <div id="dev-pair"></div>
      <div id="dev-pair-btn-box" style="margin-top:14px"></div>`, "devices paired pair another phone hub computer token"),
  };
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
  box.querySelectorAll("[data-dev]").forEach(b => b.onclick = () => deviceAction(root, b.dataset.dev, b.dataset.act));
}

function deviceRow(d) {
  const used = d.lastSeenAt ? "last used " + deviceAgo(d.lastSeenAt) : "never used";
  return `<div class="set-row"><div class="l">${esc(d.name)}<small>${esc((d.scopes || []).join(", "))} · ${esc(used)}</small></div>
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

async function deviceAction(root, id, act) {
  const d = state.devices.find(x => x.id === id);
  if (!d) return;
  if (act === "rename") {
    const name = await promptSheet({ title: "Rename device", value: d.name });
    if (name === null) return;
    try { await conn.call("devices.rename", { device: id, name }); }
    catch (e) { return toast(e.message, 4000); }
    toast("Renamed");
    return renderDevices(root);
  }
  if (act === "revoke") {
    if (!await confirmSheet({ title: "Revoke " + d.name + "?", text: "Its token stops working right away and any open connection closes. Pair it again with a new code to allow it.", ok: "Revoke", danger: true })) return;
    try { await conn.call("devices.revoke", { device: id }); }
    catch (e) { return toast(e.message, 4000); }
    toast("Revoked");
    return renderDevices(root);
  }
}

function renderPairButton(root) {
  const box = root.querySelector("#dev-pair-btn-box");
  if (!box) return;
  box.innerHTML = `<button class="btn primary" id="dev-pair-btn" style="width:100%">Pair a device</button>`;
  box.querySelector("#dev-pair-btn").onclick = () => startPairingFromUi(root);
}

async function startPairingFromUi(root) {
  const box = root.querySelector("#dev-pair");
  const btn = root.querySelector("#dev-pair-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Making a code…"; }
  let r;
  try { r = await conn.call("devices.pair"); }
  catch (e) { if (btn) { btn.disabled = false; btn.textContent = "Pair a device"; } return toast(e.message, 4000); }
  clearPairTimer();
  box.innerHTML = `<div class="pair-code" id="pair-code"></div>
    <div class="pair-exp" id="pair-exp"></div>
    <p class="note" style="text-align:center">Enter this code on the other device. It works once.</p>
    <button class="btn ghost" id="dev-pair-new" style="width:100%;margin-top:4px">Make a new code</button>`;
  box.querySelector("#pair-code").textContent = r.code;
  const exp = box.querySelector("#pair-exp");
  const tick = () => {
    if (!document.contains(box)) return clearPairTimer();   // the page closed or re-rendered
    const left = Math.max(0, r.expiresAt - Date.now());
    if (left <= 0) { exp.textContent = "This code has expired. Make a new one."; return clearPairTimer(); }
    exp.textContent = `Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
  };
  tick();
  pairTimer = setInterval(tick, 1000);
  box.querySelector("#dev-pair-new").onclick = () => { clearPairTimer(); startPairingFromUi(root); };
}
function clearPairTimer() { if (pairTimer) { clearInterval(pairTimer); pairTimer = null; } }
