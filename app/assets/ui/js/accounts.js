// accounts.js — several Claude accounts: the account chip in the composer (which account a chat runs on, and
// "continue on" for an existing chat), Settings → Claude accounts (add, sign in, rename, default, remove),
// the limit card above the message box, and the accounts in the Usage sheet.
// The server owns the logins, folders and switching (server/src/accounts.js); this file only shows and picks them.
"use strict";

state.accounts = [];           // { id, name, email, plan, default }[], the default one first (hello, "accounts")
state.defaultAccount = "default";
state.usageByAccount = {};     // account id -> usage, as state.usage (hello.usageByAccount, "usage" with account)
state.newChatAccount = null;   // the account chosen for a new chat; null = the default account

function accountById(id) { return (state.accounts || []).find(a => a.id === (id || "default")) || null; }
function accountName(id) {
  const a = accountById(id);
  return a?.name || (id && id !== "default" ? "This account" : "Default");
}
/** The account a chat runs on: the chat's own one, else the default (a new chat: the chip's choice). */
function chatAccountId() {
  const cur = state.current;
  if (cur?.isNew) return state.newChatAccount || state.defaultAccount || "default";
  return cur?.account || state.liveInfo[cur?.sessionId]?.account || state.defaultAccount || "default";
}
/** "email · plan · 5-hour 12% · week 40%", skipping what isn't known yet. */
function accountUsageText(a) {
  const u = state.usageByAccount?.[a.id];
  const h = typeof usageWindow === "function" ? usageWindow(u?.windows?.five_hour) : null;
  const w = typeof usageWindow === "function" ? usageWindow(u?.windows?.seven_day) : null;
  return [a.email, a.plan, h && "5-hour " + h.used + "%", w && "week " + w.used + "%"].filter(Boolean).join(" · ");
}
function applyAccounts(r) {
  if (r?.accounts) state.accounts = r.accounts;
  if (r?.defaultAccount) state.defaultAccount = r.defaultAccount;
  if (r?.usageByAccount) state.usageByAccount = r.usageByAccount;
  if (state.newChatAccount && !state.accounts.some(a => a.id === state.newChatAccount)) state.newChatAccount = null;
  renderAccountChip();
}
async function refreshAccounts() { try { applyAccounts(await conn.call("accounts.list")); } catch {} }

/** From `hello` (main.js): the list and everyone's numbers. */
function accountsHello(hello) {
  state.accounts = hello.accounts || [];
  state.defaultAccount = hello.defaultAccount || "default";
  state.usageByAccount = hello.usageByAccount || {};
  if (state.newChatAccount && !state.accounts.some(a => a.id === state.newChatAccount)) state.newChatAccount = null;
  renderAccountChip();
}
conn.on("accounts", m => { applyAccounts({ accounts: m.accounts, defaultAccount: m.defaultAccount }); });
conn.on("usage", m => {
  if (!m.account) return;
  state.usageByAccount = { ...state.usageByAccount, [m.account]: m.usage };
  // after every listener ran (main.js sets state.usage): an open Usage sheet shows the new numbers
  Promise.resolve().then(() => { if (sheet.key === "usage" && typeof usageRedraw === "function") usageRedraw(); });
});

// ───────────── the account chip and its sheet ─────────────
/** Where a second account matters: the composer, unless the chat runs on DeepSeek (which has no Claude login). */
function renderAccountChip() {
  const chip = $("#chip-account");
  if (!chip) return;
  const ds = typeof chatEngine === "function" && chatEngine() === "deepseek";
  chip.hidden = !(state.accounts.length >= 2 && !ds);
  if (chip.hidden) return;
  const name = accountName(chatAccountId());
  chip.textContent = name.length > 14 ? name.slice(0, 14) + "…" : name;
  chip.setAttribute("aria-label", "Claude account: " + name);
}
/** New chat: pick who runs it. Existing chat: continue it on another account (the history is shared). */
function accountSheet() {
  const cur = state.current;
  if (!cur) return;
  const mine = chatAccountId();
  if (!cur.isNew) {
    const b = sheet.open(`<h2>This chat runs on ${esc(accountName(mine))}</h2><div id="acc-opts"></div>`, { key: "account" });
    for (const a of state.accounts) {
      if (a.id === mine) continue;
      const el = h(`<button class="opt">${icon("circle")}<div class="ot"><div></div><div class="od"></div></div></button>`);
      el.querySelector(".ot div").textContent = "Continue on " + a.name;
      el.querySelector(".od").textContent = accountUsageText(a) || "Same chats, files and memory";
      el.onclick = () => { sheet.close(true); continueOnAccount(a, cur.sessionId); };
      b.querySelector("#acc-opts").append(el);
    }
    return;
  }
  const b = sheet.open(`<h2>Run this chat on</h2><div id="acc-opts"></div>`, { key: "account" });
  for (const a of state.accounts) {
    const on = a.id === mine;
    const el = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div></div><div class="od"></div></div></button>`);
    el.querySelector(".ot div").textContent = a.name;
    el.querySelector(".od").textContent = accountUsageText(a);
    el.onclick = () => { sheet.close(true); state.newChatAccount = a.id; renderAccountChip(); };
    b.querySelector("#acc-opts").append(el);
  }
}
$("#chip-account").onclick = () => accountSheet();

/** Move an existing chat to another account; its next message starts the chat there. */
async function continueOnAccount(a, sessionId) {
  try { await conn.call("chat.account", { sessionId, account: a.id }); } catch (e) { return toast(e.message, 4000); }
  const cur = state.current;
  if (cur && cur.sessionId === sessionId) { cur.account = a.id; hideAccountLimit(); }
  renderAccountChip();
  toast("Your next message goes to " + a.name);
}

// ───────────── the limit card ─────────────
function hideAccountLimit() { const el = $("#account-limit"); if (el) { el.hidden = true; el.textContent = ""; } }
/** "<Name> is at its weekly limit · resets in 2h · Continue on <Other>": one tap carries the chat on elsewhere. */
function showAccountLimit(m) {
  const el = $("#account-limit");
  if (!el) return;
  const which = m.limit === "five_hour" ? "5-hour" : m.limit === "seven_day" ? "weekly" : "usage";
  const when = typeof usageResets === "function" ? usageResets(m.resetsAt) : "";
  const others = state.accounts.filter(a => a.id !== (m.account || "default") && a.email);
  el.innerHTML = `<span class="al-line">${icon("info")}<span id="al-text"></span></span><span class="al-btns"></span>`;
  el.querySelector("#al-text").textContent = `${accountName(m.account)} is at its ${which} limit${when ? " · " + when : ""}`;
  const box = el.querySelector(".al-btns");
  for (const a of others) {
    const btn = h(`<button class="chip" data-acc="${esc(a.id)}"></button>`);
    btn.textContent = "Continue on " + a.name;
    btn.onclick = () => continueFromLimit(a, m.sessionId, el);
    box.append(btn);
  }
  el.hidden = false;
}
async function continueFromLimit(a, sessionId, el) {
  el.querySelectorAll("button").forEach(x => x.disabled = true);
  try { await conn.call("chat.account", { sessionId, account: a.id }); }
  catch (e) { el.querySelectorAll("button").forEach(x => x.disabled = false); return toast(e.message, 4000); }
  const cur = state.current;
  if (cur && cur.sessionId === sessionId) cur.account = a.id;
  renderAccountChip();
  await send("[Pocket Agent] Continued on the " + a.name + " account. Carry on where you left off.");
  el.hidden = true;
}
conn.on("account.limit", m => {
  const cur = state.current;
  if (!cur || cur.isNew || m.sessionId !== cur.sessionId) return;
  showAccountLimit(m);
});
/** A chat switch (or a new chat) belongs to its own account: the old card no longer applies. */
function accountsChatChanged() { hideAccountLimit(); renderAccountChip(); }
function accountsNewChat() { state.newChatAccount = null; hideAccountLimit(); renderAccountChip(); }

// ───────────── Settings → Claude accounts ─────────────
function accountRow(a) {
  const isDefault = a.id === (state.defaultAccount || "default");
  const bits = [a.email, a.plan, isDefault ? "default" : ""].filter(Boolean);
  const chips = (isDefault ? "" : `<button class="chip" data-acc="${esc(a.id)}" data-act="default">Make default</button>`)
    + `<button class="chip" data-acc="${esc(a.id)}" data-act="rename">Rename</button>`
    + (a.email ? "" : `<button class="chip" data-acc="${esc(a.id)}" data-act="login">Sign in</button>`)
    + (a.id === "default" ? "" : `<button class="chip danger" data-acc="${esc(a.id)}" data-act="remove">Remove</button>`);
  return item(`<div class="set-row acc-row"><div class="l">${esc(a.name)}<small>${esc(bits.join(" · "))}</small></div><div class="acc-chips">${chips}</div></div>`,
    "claude accounts account " + (a.email || "") + " " + (a.plan || ""));
}
function accountsSettingsSection() {
  const accs = state.accounts || [];
  const def = accs.find(a => a.id === state.defaultAccount) || accs[0];
  return {
    id: "accounts", title: "Claude accounts", icon: "globe",
    summary: `${accs.length} account${accs.length === 1 ? "" : "s"} · new chats: ${def?.name || "Default"}`,
    html: () => accs.map(accountRow).join("")
      + item(`<div class="set-row"><div class="l">Add account<small>Another Claude login: same chats, files and settings</small></div><button class="chip" id="acc-add">Add</button></div>`,
        "claude accounts account add login another"),
  };
}
/** Hooks up the rows above (wireSettings calls this for every settings page and search result). */
function wireAccountsSettings(root) {
  root.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => accountAction(b.dataset.acc, b.dataset.act));
  root.querySelector("#acc-add")?.addEventListener("click", addAccountFlow);
}
async function accountAction(id, act) {
  if (act === "default") return makeAccountDefault(id);
  if (act === "rename") return renameAccountPrompt(id);
  if (act === "login") return accountLoginSheet(accountById(id) || { id, name: accountName(id) });
  if (act === "remove") return removeAccountPrompt(id);
}
async function makeAccountDefault(id) {
  try { const r = await conn.call("accounts.setDefault", { id }); applyAccounts({ accounts: r.accounts, defaultAccount: id }); }
  catch (e) { return toast(e.message, 4000); }
  openSettingsRefresh();
  toast("New chats use " + accountName(id));
}
async function renameAccountPrompt(id) {
  const a = accountById(id) || { id, name: "" };
  const name = await promptSheet({ title: "Rename account", value: a.name });
  if (name === null) return;
  try { applyAccounts({ accounts: (await conn.call("accounts.rename", { id, name })).accounts }); }
  catch (e) { return toast(e.message, 4000); }
  openSettingsRefresh();
}
async function removeAccountPrompt(id) {
  const a = accountById(id) || { id, name: "this account" };
  if (!await confirmSheet({ title: "Remove " + a.name + "?", text: "Its Claude login is deleted from this phone. Its chats move to the default account.", ok: "Remove", danger: true })) return;
  try { applyAccounts({ accounts: (await conn.call("accounts.remove", { id })).accounts }); }
  catch (e) { return toast(e.message, 4000); }
  if (state.defaultAccount === id) state.defaultAccount = "default";
  if (state.newChatAccount === id) state.newChatAccount = null;
  openSettingsRefresh();
  toast("Removed");
}

// ───────────── adding an account and signing it in ─────────────
async function addAccountFlow() {
  const name = await promptSheet({ title: "Name the account", value: "Work" });
  if (name === null) return;
  let r;
  try { r = await conn.call("accounts.add", { name }); } catch (e) { return toast(e.message, 4000); }
  if (!r.account) return;
  state.accounts = [...state.accounts, { ...r.account, default: false }];
  renderAccountChip();
  accountLoginSheet(r.account);
}
/** The server runs `claude auth login` for the account: open the link, then paste the code it shows. */
function accountLoginSheet(a) {
  const b = sheet.open(`<h2>Sign in to ${esc(a.name)}</h2>
    <div class="sub">Open the sign-in page, sign in with that Claude account, then paste the code it shows.</div>
    <button class="btn primary" id="acc-open" style="width:100%">Open sign-in page</button>
    <input class="field" id="acc-code" placeholder="Paste the code" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Sign-in code">
    <p class="acc-err" id="acc-err" role="alert" hidden></p>
    <div class="btns row2"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" id="acc-finish" disabled>Finish</button></div>`,
  { key: "account-login:" + a.id });
  const inp = b.querySelector("#acc-code"), err = b.querySelector("#acc-err"), finish = b.querySelector("#acc-finish"), open = b.querySelector("#acc-open");
  setTimeout(() => inp.focus(), 250);
  const showErr = msg => { err.textContent = msg; err.hidden = false; };
  inp.oninput = () => { finish.disabled = !inp.value.trim(); err.hidden = true; };
  b.querySelector('[data-a="cancel"]').onclick = () => sheet.close(true);
  open.onclick = async () => {
    open.disabled = true; open.textContent = "Opening…"; err.hidden = true;
    try { openAccountUrl((await conn.call("accounts.login.start", { id: a.id })).url); }
    catch (e) { showErr(e.message); }
    open.disabled = false; open.textContent = "Open sign-in page";
  };
  finish.onclick = async () => {
    const code = inp.value.trim();
    if (!code || finish.disabled) return;
    finish.disabled = true; finish.textContent = "Signing in…"; err.hidden = true;
    try {
      const st = (await conn.call("accounts.login.code", { id: a.id, code })).status || {};
      sheet.close(true);
      toast(st.email ? "Signed in as " + st.email : "Signed in", 3000);
      await refreshAccounts();
      openSettingsRefresh();
    } catch (e) { showErr(e.message); finish.disabled = false; finish.textContent = "Finish"; }
  };
}
/** The app opens links with Android's browser (Rpc.java "url.open"); a plain browser opens a tab. */
function openAccountUrl(url) {
  if (!url) return;
  if (native && typeof native.rpc === "function") nativeRpc("url.open", { url }).catch(e => toast(e.message));
  else window.open(url, "_blank", "noopener");
}

// ───────────── Usage sheet: everyone else's numbers ─────────────
/** After the plan limits (the default account's): what each other account has used. */
function accountsUsageHtml() {
  if ((state.accounts || []).length < 2) return "";
  const others = state.accounts.filter(a => a.id !== "default");
  if (!others.length) return "";
  return `<h3 class="u-sec">Other accounts</h3><div class="u-list">${others.map(a => {
    const u = state.usageByAccount?.[a.id];
    const h = typeof usageWindow === "function" ? usageWindow(u?.windows?.five_hour) : null;
    const w = typeof usageWindow === "function" ? usageWindow(u?.windows?.seven_day) : null;
    const bits = [h && "5-hour " + h.used + "%", w && "week " + w.used + "%"].filter(Boolean);
    return `<div class="set-row"><div class="l">${esc(a.name)}<small>${esc(bits.join(" · ") || "No numbers yet")}</small></div></div>`;
  }).join("")}</div>`;
}
