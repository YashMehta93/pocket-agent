// profiles.js — Profiles: whose work a chat is. Settings → Profiles lists and edits them (name, colour,
// folders, the Claude account, environment variables, the default); with two or more, the chats drawer filters
// by profile, chat rows show their profile's colour, and a new chat says which profile its folder falls in.
// The server owns the folders, the longest-workspace rule and the saving (server/src/profiles.js).
"use strict";

const PROFILE_COLORS = ["teal", "blue", "violet", "rose", "amber", "green", "slate"];
const PROFILE_COLOR_LABEL = { teal: "Teal", blue: "Blue", violet: "Violet", rose: "Rose", amber: "Amber", green: "Green", slate: "Slate" };
const PROFILE_FILTER_KEY = "pa.profileFilter";

state.profiles = [];              // { id, name, color, workspaces[], accounts{ local }, env{} }[], from hello / "profiles"
state.defaultProfile = "personal";
state.profileFilter = "";         // the drawer's filter: "" = All, else a profile id (remembered on this device)
try { state.profileFilter = localStorage.getItem(PROFILE_FILTER_KEY) || ""; } catch {}

function profileById(id) { return (state.profiles || []).find(p => p.id === id) || null; }
function defaultProfile() { return profileById(state.defaultProfile) || (state.profiles || [])[0] || null; }
function profileMany() { return (state.profiles || []).length >= 2; }
function profileColor(p) { return PROFILE_COLORS.includes(p?.color) ? p.color : "teal"; }
function pdot(p) { return `<span class="pdot pc-${profileColor(p)}" aria-hidden="true"></span>`; }
function profileChip(p) { return p ? `<span class="pchip">${pdot(p)}${esc(p.name)}</span>` : ""; }

/** The profile a folder is in: its longest matching workspace, else the default profile (the same rule as the server). */
function profileOfCwd(cwd) {
  const dir = String(cwd || "");
  let best = null, bestLen = -1;
  for (const p of state.profiles || []) for (const w of p.workspaces || []) {
    if ((dir === w || dir.startsWith(w + "/")) && w.length > bestLen) { best = p; bestLen = w.length; }
  }
  return best || defaultProfile();
}
/** A chat's profile id; a worker follows its parent when the parent is in `byId` (nested linked chats too). */
function sessionProfileId(s, byId, links) {
  let cur = s;
  const seen = new Set();
  while (cur) {
    const par = links?.[cur.sessionId]?.parent;
    if (!par || seen.has(par) || !byId?.has(par)) break;
    seen.add(par);
    cur = byId.get(par);
  }
  return cur.profile || profileOfCwd(cur.cwd)?.id || "";
}
/** A chat row's profile object from its folder; a row grouped under its parent gets the parent's (sessions.js). */
function profileOfSession(s) { return profileMany() ? profileById(s.profile) || profileOfCwd(s.cwd) || null : null; }

// ───────────── state: hello and the "profiles" event ─────────────
function profilesHello(hello) {
  if (Array.isArray(hello.profiles)) state.profiles = hello.profiles;
  if (hello.defaultProfile) state.defaultProfile = hello.defaultProfile;
  profilesChanged();
}
/** After save, remove or setDefault: the server broadcasts the whole list. */
function applyProfiles(r) {
  if (Array.isArray(r?.profiles)) state.profiles = r.profiles;
  if (r?.defaultProfile) state.defaultProfile = r.defaultProfile;
  profilesChanged();
}
function profilesChanged() {
  if (state.profileFilter && !profileById(state.profileFilter)) setProfileFilter("", false);
  renderProfileFilter();
  renderSessions();
  if (state.current) updateHeader();
  // a new chat's empty state already drew its folder before hello brought the profiles
  if (state.current?.isNew && !$("#empty").hidden) showEmpty();
}

// ───────────── the drawer's filter row (two or more profiles) ─────────────
function renderProfileFilter() {
  const box = $("#profile-filters");
  if (!box) return;
  const many = profileMany();
  box.hidden = !many;
  box.innerHTML = "";
  if (!many) return;
  const chip = (id, label) => {
    const on = (state.profileFilter || "") === id;
    const b = h(`<button type="button" class="${on ? "on" : ""}"></button>`);
    b.textContent = label;
    b.setAttribute("aria-pressed", on);
    b.onclick = () => setProfileFilter(id);
    return b;
  };
  box.append(chip("", "All"));
  for (const p of state.profiles) box.append(chip(p.id, p.name));
}
function setProfileFilter(id, rerender = true) {
  state.profileFilter = id || "";
  try { if (state.profileFilter) localStorage.setItem(PROFILE_FILTER_KEY, state.profileFilter); else localStorage.removeItem(PROFILE_FILTER_KEY); } catch {}
  if (!rerender) return;
  renderProfileFilter();
  renderSessions();
}

// ───────────── Settings → Profiles ─────────────
function folderCount(p) { const n = (p.workspaces || []).length; return n ? `${n} folder${n === 1 ? "" : "s"}` : "No folders"; }
/** The Claude account a profile's chats use: its own choice, else the app's default account. */
function profileAccountId(p) { return p?.accounts?.local || state.defaultAccount || "default"; }
function isAppDefaultAccount(id) { return (id || "default") === (state.defaultAccount || "default"); }
/** A real account name, never the word "Default": the account's own name, else its email. */
function accountRealName(id) {
  const a = accountById(id);
  if (a?.name && a.name !== "Default") return a.name;
  if (a?.email) return a.email;
  return (id || "default") === "default" ? state.account?.email || state.account?.organization || "Claude account" : "Claude account";
}
function profileAccountMeta(a, id) {
  const u = state.usageByAccount?.[id];
  const h5 = typeof usageWindow === "function" ? usageWindow(u?.windows?.five_hour) : null;
  const w = typeof usageWindow === "function" ? usageWindow(u?.windows?.seven_day) : null;
  const bits = [isAppDefaultAccount(id) ? "(app default)" : "", a?.email && a.email !== accountRealName(id) ? a.email : "",
    a?.plan, h5 && "5-hour " + h5.used + "%", w && "week " + w.used + "%"];
  return bits.filter(Boolean).join(" · ") || "Same chats, files and memory";
}
function profileAccountLabel(id) {
  return `${esc(accountRealName(id))}${isAppDefaultAccount(id) ? ' <span class="pf-muted">(app default)</span>' : ""}`;
}

function profilesSettingsSection() {
  return {
    id: "profiles", title: "Profiles", icon: "circle",
    summary: (state.profiles || []).map(p => p.name).join(", ") || "Personal",
    html: () => (state.profiles || []).map(p => item(`<button type="button" class="prof-row" data-profile="${esc(p.id)}">
        ${pdot(p)}<span class="l">${esc(p.name)}<small>${esc(folderCount(p))} · ${esc(accountRealName(profileAccountId(p)))}</small></span>
        <span class="go" aria-hidden="true">›</span></button>`, `profile profiles ${p.name} ${folderCount(p)} ${accountRealName(profileAccountId(p))} ${(p.workspaces || []).join(" ")}`)).join("")
      + item(`<button type="button" class="prof-new" id="prof-new">New profile</button>`, "profile profiles new add"),
  };
}
/** Hooks up the rows above (wireSettings calls this for the settings page and its search results). */
function wireProfilesSettings(root) {
  root.querySelectorAll("[data-profile]").forEach(b => b.onclick = () => {
    const p = profileById(b.dataset.profile);
    if (p) openProfileEditor(p);
  });
  root.querySelector("#prof-new")?.addEventListener("click", () => openProfileEditor(null));
}

// ───────────── one profile's editor ─────────────
function copyProfile(p) {
  return { id: p.id, name: p.name, color: profileColor(p), workspaces: [...(p.workspaces || [])], accounts: { ...(p.accounts || {}) }, env: { ...(p.env || {}) } };
}
function blankProfile() {
  const used = new Set((state.profiles || []).map(p => p.color));
  return { name: "", color: PROFILE_COLORS.find(c => !used.has(c)) || "teal", workspaces: [], accounts: {}, env: {} };
}
function envText(env) { return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join("\n"); }
/** One KEY=value per line; a line without "=" is a mistake we can name before asking the server. */
function parseProfileEnv(text) {
  const env = {};
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i < 1) throw new Error("Each line is KEY=value, one per line");
    env[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return env;
}

function openProfileEditor(profile) {
  const draft = profile ? copyProfile(profile) : blankProfile();
  page.open(draft.id ? draft.name : "New profile", body => renderProfileEditor(body, draft), "", null, { ltr: true });
}
function renderProfileEditor(body, draft) {
  const isNew = !draft.id;
  const isDefault = !isNew && draft.id === state.defaultProfile;
  const accId = profileAccountId(draft);
  body.innerHTML = `<div class="settings pf-editor">
    <p class="pf-err" data-for="top" role="alert" hidden></p>
    <h3>Name</h3>
    <input class="field" id="pf-name" value="${esc(draft.name)}" placeholder="Personal, Work…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Profile name">
    <p class="pf-err" data-for="name" role="alert" hidden></p>
    <h3>Colour</h3>
    <div class="pf-colours" role="radiogroup" aria-label="Profile colour">${PROFILE_COLORS.map(c =>
      `<button type="button" class="pf-sw pc-${c}${profileColor(draft) === c ? " on" : ""}" data-color="${c}" role="radio" aria-checked="${profileColor(draft) === c}" aria-label="${PROFILE_COLOR_LABEL[c]}"></button>`).join("")}</div>
    <h3>Folders</h3>
    <div id="pf-folders"></div>
    <p class="pf-err" data-for="folders" role="alert" hidden></p>
    <button type="button" class="prof-new" id="pf-add">Add folder</button>
    <h3>Claude account</h3>
    <div class="set-row"><div class="l">This profile's chats run on<small id="pf-account">${profileAccountLabel(accId)}</small></div><button type="button" class="chip" id="pf-account-btn">Change</button></div>
    <p class="pf-err" data-for="account" role="alert" hidden></p>
    <h3>Environment variables</h3>
    <textarea class="field pf-env" id="pf-env" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Environment variables">${esc(envText(draft.env))}</textarea>
    <p class="pf-hint">Use $SECRETS for this profile's secrets folder.</p>
    <p class="pf-err" data-for="env" role="alert" hidden></p>
    <div class="btns"><button type="button" class="btn primary" id="pf-save">Save</button></div>
    <div class="pf-acts">${!isNew && !isDefault ? `<button type="button" class="chip" id="pf-default">Make default</button>` : ""}${!isNew && (state.profiles || []).length > 1 ? `<button type="button" class="chip danger" id="pf-delete">Delete profile</button>` : ""}</div>
  </div>`;

  renderEditorFolders(body, draft);
  const name = body.querySelector("#pf-name");
  name.oninput = () => { draft.name = name.value; hideProfileErrors(body); };
  body.querySelectorAll("[data-color]").forEach(b => b.onclick = () => {
    draft.color = b.dataset.color;
    body.querySelectorAll("[data-color]").forEach(x => { const on = x.dataset.color === draft.color; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); });
  });
  body.querySelector("#pf-add").onclick = async () => {
    hideProfileErrors(body);
    const w = await pickFolder(draft.workspaces?.[0] || state.current?.cwd);
    if (!w || (draft.workspaces || []).includes(w)) return;
    (draft.workspaces ||= []).push(w);
    renderEditorFolders(body, draft);
  };
  body.querySelector("#pf-account-btn").onclick = () => profileAccountSheet(draft, body);
  body.querySelector("#pf-save").onclick = () => saveProfileDraft(body, draft);
  body.querySelector("#pf-default")?.addEventListener("click", async () => {
    if (!draft.id) return;
    hideProfileErrors(body);
    try { applyProfiles(await conn.call("profiles.setDefault", { profile: draft.id })); }
    catch (e) { return showProfileError(body, profileErrorField(e.message), e.message); }
    body.querySelector("#pf-default")?.remove();
    toast(`${draft.name || "This profile"} is now the default`);
  });
  body.querySelector("#pf-delete")?.addEventListener("click", async () => {
    if (!draft.id) return;
    const name = draft.name || "this profile";
    if (!await confirmSheet({ title: `Delete ${name}?`, ok: "Delete", danger: true,
      text: "Its chats stay where they are and now belong to the default profile. Its secrets folder is kept on this phone." })) return;
    hideProfileErrors(body);
    try { await conn.call("profiles.remove", { profile: draft.id }); }
    catch (e) { return showProfileError(body, profileErrorField(e.message), e.message); }
    try { applyProfiles(await conn.call("profiles.list")); } catch {}
    page.back();
    toast("Deleted");
  });
}
function renderEditorFolders(body, draft) {
  const box = body.querySelector("#pf-folders");
  if (!box) return;
  box.innerHTML = "";
  if (!(draft.workspaces || []).length) { box.innerHTML = `<div class="pf-none">No folders yet.</div>`; return; }
  for (const w of draft.workspaces) {
    const row = h(`<div class="set-row pf-folder"><div class="l"></div><button type="button" class="pf-x" aria-label="Remove folder" data-icon="x"></button></div>`);
    row.querySelector(".l").textContent = shortPath(w);
    row.querySelector(".pf-x").onclick = () => { draft.workspaces = draft.workspaces.filter(x => x !== w); renderEditorFolders(body, draft); };
    box.append(row);
  }
}
/** The account list (state.accounts): real names, the app's default marked, never "Default". */
function profileAccountSheet(draft, body) {
  const mine = profileAccountId(draft);
  const accs = (state.accounts || []).length ? state.accounts : [{ id: state.defaultAccount || "default", name: "" }];
  const b = sheet.open(`<h2>Account for this profile</h2><div class="sub">Chats in this profile's folders run on this Claude account, unless a chat chose another.</div><div id="pf-accs"></div>`);
  for (const a of accs) {
    const id = a.id || "default";
    const on = id === mine;
    const el = h(`<button type="button" class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div></div><div class="od"></div></div></button>`);
    el.querySelector(".ot div").textContent = accountRealName(id);
    el.querySelector(".od").textContent = profileAccountMeta(a, id);
    el.onclick = () => {
      // The app's default account means "follow it if the default changes", so the profile stores no choice.
      if (isAppDefaultAccount(id)) delete draft.accounts.local;
      else draft.accounts = { ...(draft.accounts || {}), local: id };
      const out = body.querySelector("#pf-account");
      if (out) out.innerHTML = profileAccountLabel(profileAccountId(draft));
      hideProfileErrors(body);
      sheet.close(true);
    };
    b.querySelector("#pf-accs").append(el);
  }
}
async function saveProfileDraft(body, draft) {
  hideProfileErrors(body);
  let env;
  try { env = parseProfileEnv(body.querySelector("#pf-env").value); }
  catch (e) { return showProfileError(body, "env", e.message); }
  const profile = { name: body.querySelector("#pf-name").value.trim(), color: draft.color, workspaces: [...(draft.workspaces || [])],
    accounts: { ...(draft.accounts || {}) }, env };
  if (draft.id) profile.id = draft.id;
  const btn = body.querySelector("#pf-save");
  btn.disabled = true; btn.textContent = "Saving…";
  let r;
  try { r = await conn.call("profiles.save", { profile }); }
  catch (e) {
    btn.disabled = false; btn.textContent = "Save";
    return showProfileError(body, profileErrorField(e.message), e.message);
  }
  try { applyProfiles(await conn.call("profiles.list")); } catch {}
  page.back();
  toast(draft.id ? "Saved" : `${r.profile?.name || profile.name} added`);
}

// ───────────── errors, next to the field they are about ─────────────
function profileErrorField(msg) {
  const m = String(msg || "");
  if (/folder|workspace|already in/i.test(m)) return "folders";
  if (/profile.*name|needs a name/i.test(m)) return "name";
  if (/account|"local"/i.test(m)) return "account";
  if (/variable|environment|can't be set|must be text|too long/i.test(m)) return "env";
  return "top";
}
function hideProfileErrors(body) { body.querySelectorAll(".pf-err").forEach(el => { el.hidden = true; el.textContent = ""; }); }
function showProfileError(body, field, msg) {
  const el = body.querySelector(`.pf-err[data-for="${field}"]`) || body.querySelector('.pf-err[data-for="top"]');
  if (!el) return toast(msg, 5000);
  el.textContent = msg;
  el.hidden = false;
  el.scrollIntoView?.({ block: "nearest" });
}

renderProfileFilter();
