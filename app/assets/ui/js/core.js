// core.js — icons, utilities, native bridge, settings, connection, sheets/pages.
"use strict";

// ───────────── icons (inline SVG, stroke style) ─────────────
const ICONS = {
  menu: "M4 7h16M4 12h16M4 17h10", plus: "M12 5v14M5 12h14", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", dots: "M12 6h.01M12 12h.01M12 18h.01",
  down: "M12 5v14M6 13l6 6 6-6", up: "M12 19V5M6 11l6-6 6 6", stop: "M8 8h8v8H8z", clip: "M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8",
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v3", back: "M15 18l-6-6 6-6",
  x: "M6 6l12 12M18 6L6 18", check: "M5 12l5 5L20 7", copy: "M9 9h10v10H9zM5 15V5h10", edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  retry: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5", share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M7 8l5-5 5 5",
  terminal: "M5 8l4 4-4 4M12 16h7", file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5",
  pencil: "M4 20h4L19 9l-4-4L4 16z", eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  list: "M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01", bot: "M12 8V4M8 4h8M5 8h14v11H5zM9 13h.01M15 13h.01",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", ccheck: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6",
  cdot: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12h.01", pin: "M9 4h6l-1 6 4 3H6l4-3zM12 13v8",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", fork: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7h.01",
  brain: "M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 3 5 3 3 0 0 0 6 0V7a3 3 0 0 0-4-3zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-3 5 3 3 0 0 1-6 0",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z", key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z", download: "M12 3v13M7 11l5 5 5-5M4 21h16",
  image: "M4 5h16v14H4zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 16l-5-5L5 19", camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  plan: "M9 5h11M9 12h11M9 19h11M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2", question: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3", wifi: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0",
};
function icon(name) {
  const d = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
function hydrateIcons(root = document) { root.querySelectorAll("[data-icon]").forEach(el => { if (!el.querySelector("svg")) el.insertAdjacentHTML("beforeend", icon(el.dataset.icon)); }); }

// ───────────── utilities ─────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); hydrateIcons(t.content); return t.content.firstElementChild; }
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function relTime(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "now"; if (d < 3600) return Math.floor(d / 60) + "m"; if (d < 86400) return Math.floor(d / 3600) + "h";
  if (d < 604800) return Math.floor(d / 86400) + "d";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtDur(ms) { if (ms < 1000) return ms + "ms"; const s = ms / 1000; if (s < 60) return s.toFixed(1) + "s"; return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s"; }
function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); }
function shortPath(p) { const home = state.home; return p && home && p.startsWith(home) ? "~" + p.slice(home.length) : (p || ""); }
function baseName(p) { return (p || "").replace(/\/+$/, "").split("/").pop() || "/"; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ───────────── native bridge (Android WebView) ─────────────
const native = window.PA || null;
const callbacks = {};
window.paNative = { // called from Java
  emit(name, json) { const cb = callbacks[name]; if (cb) cb(typeof json === "string" ? JSON.parse(json || "null") : json); },
};
function nativeCall(fn, ...args) { try { return native && typeof native[fn] === "function" ? native[fn](...args) : undefined; } catch (e) { console.warn(fn, e); } }

/** Calls a native capability (app/src/.../Rpc.java), e.g. nativeRpc("device.info"). Needs app v0.1.6+. */
const rpcWaiting = new Map();
let rpcN = 0;
function nativeRpc(method, params = {}) {
  if (!native || typeof native.rpc !== "function") return Promise.reject(new Error("Update the Pocket Agent app to use this"));
  const id = "r" + (++rpcN);
  return new Promise((resolve, reject) => {
    rpcWaiting.set(id, { resolve, reject });
    native.rpc(id, method, JSON.stringify(params));
  });
}
callbacks.rpc = r => { const w = rpcWaiting.get(r.id); if (!w) return; rpcWaiting.delete(r.id); r.error ? w.reject(new Error(r.error)) : w.resolve(r.result); };
function haptic(kind = "tick") { if (settings.haptics) nativeCall("haptic", kind); }
function copyText(t) {
  if (native) { nativeCall("copy", t); toast("Copied"); return; }
  navigator.clipboard?.writeText(t).then(() => toast("Copied"), () => toast("Copy failed"));
}
function shareText(t, title) { if (native) nativeCall("share", t, title || ""); else copyText(t); }

// ───────────── settings (per device) ─────────────
const SETTINGS_KEY = "pa.settings";
const settings = Object.assign({
  theme: "system", fontSize: 15.5, enterToSend: false, haptics: true, showThinking: true, autoExpandTools: false,
  server: "", token: "", notifyDone: true, notifyApproval: true,
}, (() => {
  // In the app, settings live natively: the built-in server, Termux and a PC are different web
  // origins with separate localStorage, and settings should survive switching between them.
  try { const n = native && typeof native.uiSettings === "function" ? JSON.parse(native.uiSettings() || "{}") : null; if (n && Object.keys(n).length) return n; } catch {}
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; }
})());
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} applySettings(); nativeCall("settingsChanged", JSON.stringify(settings)); }
function applySettings() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--fs", settings.fontSize + "px");
  $("#hl-theme").href = dark ? "lib/hl-dark.css" : "lib/hl-light.css";
  nativeCall("setTheme", dark ? "dark" : "light", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applySettings);

// ───────────── app state ─────────────
const state = {
  home: "", hostName: "", sessions: [], pinned: [], commands: [], models: [], account: null, defaults: {},
  liveInfo: {},     // sessionId -> info from server (state, model, mode, pending…)
  pending: [],      // permission requests (all sessions)
  current: null,    // { sessionId, cwd, title, isNew, lastSeq, … }
  filter: "", project: "",
};

// ───────────── connection ─────────────
const conn = {
  ws: null, ok: false, n: 0, waiting: new Map(), listeners: {}, retry: 0,
  base() { return (settings.server || nativeCall("serverUrl") || (location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8765")).replace(/\/$/, ""); },
  /** A typed-in token applies only to a custom server; the built-in server uses the app's own token. */
  token() { return (settings.server && settings.token) || nativeCall("token") || new URLSearchParams(location.hash.slice(1)).get("token") || settings.token || ""; },
  url() { return this.base().replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(this.token()); },
  /** "up" = server reachable (so a failing socket means the token is wrong), "down" = unreachable. */
  async probe() {
    try { const r = await fetch(this.base() + "/health", { cache: "no-store" }); return r.ok ? "up" : "down"; } catch { return "down"; }
  },
  connect() {
    clearTimeout(this.timer);
    let ws;
    try { ws = new WebSocket(this.url()); } catch (e) { return this.scheduleRetry(); }
    this.ws = ws;
    ws.onopen = () => { this.ok = true; this.retry = 0; this.fire("open"); };
    ws.onclose = () => {
      const was = this.ok; this.ok = false;
      for (const [, cb] of this.waiting) cb({ error: "Disconnected" });
      this.waiting.clear();
      if (was) this.fire("close");
      this.scheduleRetry();
    };
    ws.onerror = () => {};
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "reply") { const cb = this.waiting.get(m.id); this.waiting.delete(m.id); cb?.(m); return; }
      this.fire(m.t, m);
    };
  },
  scheduleRetry() {
    this.retry++;
    // Ask Android to start the Termux server only if it has really been down for a while, and only once
    // per app start: without Termux's allow-external-apps setting each attempt posts an error notification.
    if (this.retry === 8 && !this.askedStart) this.probe().then(s => { if (s === "down") { this.askedStart = true; nativeCall("ensureServer"); } });
    this.fire("retrying", this.retry);
    this.timer = setTimeout(() => this.connect(), Math.min(800 * this.retry, 5000));
  },
  call(t, m = {}) {
    return new Promise((res, rej) => {
      if (!this.ok) return rej(new Error("Not connected to the server"));
      const id = ++this.n;
      this.waiting.set(id, r => r.error ? rej(Object.assign(new Error(r.error), { code: r.code, kind: r.kind, short: r.short })) : res(r));
      this.ws.send(JSON.stringify({ t, id, ...m }));
    });
  },
  on(t, fn) { (this.listeners[t] ||= []).push(fn); },
  fire(t, m) { (this.listeners[t] || []).forEach(fn => { try { fn(m); } catch (e) { console.error(t, e); } }); },
};

// ───────────── toast / sheet / page ─────────────
let toastTimer;
function toast(msg, ms = 1800) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms); }

const sheet = {
  onClose: null, key: null,
  open(html, { onClose, key } = {}) {
    this.close(true);
    const body = $("#sheet-body");
    body.innerHTML = "";
    if (typeof html === "string") body.innerHTML = html; else body.append(html);
    hydrateIcons(body);
    this.onClose = onClose || null; this.key = key || null;
    document.body.classList.add("sheet-open");
    nativeCall("setBackHandler", true);
    return body;
  },
  close(silent) {
    if (!document.body.classList.contains("sheet-open")) return;
    document.body.classList.remove("sheet-open");
    const cb = this.onClose; this.onClose = null; this.key = null;
    if (!silent && cb) cb();
  },
  get isOpen() { return document.body.classList.contains("sheet-open"); },
};
$("#sheet-scrim").addEventListener("click", () => sheet.close());

const page = {
  stack: [],
  open(title, render, actions = "") {
    $("#page").hidden = false;
    $("#page-title").textContent = title;
    $("#page-actions").innerHTML = actions; hydrateIcons($("#page-actions"));
    const body = $("#page-body"); body.innerHTML = ""; body.scrollTop = 0;
    this.stack.push({ title, render, actions });
    render(body);
    nativeCall("setBackHandler", true);
  },
  back() {
    this.stack.pop();
    const prev = this.stack.pop();
    if (prev) this.open(prev.title, prev.render, prev.actions); else this.close();
  },
  close() { this.stack = []; $("#page").hidden = true; $("#page-body").innerHTML = ""; },
  get isOpen() { return !$("#page").hidden; },
};
$("#page-back").addEventListener("click", () => page.back());

// Android back button: close the top-most layer. Returns true if handled.
window.paBack = function () {
  if (sheet.isOpen) { sheet.close(); return true; }
  if (page.isOpen) { page.back(); return true; }
  if (!$("#popup").hidden) { $("#popup").hidden = true; return true; }
  if (document.body.classList.contains("drawer-open")) { document.body.classList.remove("drawer-open"); return true; }
  return false;
};

function confirmSheet({ title, text = "", ok = "OK", danger = false }) {
  return new Promise(res => {
    const b = sheet.open(`<h2>${esc(title)}</h2>${text ? `<div class="sub">${esc(text)}</div>` : ""}
      <div class="btns row2"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-r="1">${esc(ok)}</button></div>`,
      { onClose: () => res(false) });
    b.querySelectorAll("[data-r]").forEach(x => x.onclick = () => { const v = x.dataset.r === "1"; sheet.close(true); res(v); });
  });
}
function promptSheet({ title, value = "", placeholder = "", ok = "Save", multiline = false }) {
  return new Promise(res => {
    const b = sheet.open(`<h2>${esc(title)}</h2>${multiline ? `<textarea class="field" id="ps-in" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input class="field" id="ps-in" value="${esc(value)}" placeholder="${esc(placeholder)}">`}
      <div class="btns row2"><button class="btn ghost" data-r="0">Cancel</button><button class="btn primary" data-r="1">${esc(ok)}</button></div>`,
      { onClose: () => res(null) });
    const inp = b.querySelector("#ps-in"); setTimeout(() => { inp.focus(); inp.select?.(); }, 250);
    const done = v => { sheet.close(true); res(v); };
    b.querySelector('[data-r="0"]').onclick = () => done(null);
    b.querySelector('[data-r="1"]').onclick = () => done(inp.value.trim());
    if (!multiline) inp.onkeydown = e => { if (e.key === "Enter") done(inp.value.trim()); };
  });
}
function menuSheet(title, items) {
  const b = sheet.open(`${title ? `<h2>${esc(title)}</h2>` : ""}<div>${items.filter(Boolean).map((it, i) =>
    `<button class="menu-item ${it.danger ? "danger" : ""}" data-i="${i}">${icon(it.icon || "info")}<span>${esc(it.label)}</span></button>`).join("")}</div>`);
  const list = items.filter(Boolean);
  b.querySelectorAll("[data-i]").forEach(x => x.onclick = () => { sheet.close(true); list[+x.dataset.i].run(); });
}
