// pages.js — overflow menu, context usage, commands list, file browser, folder picker, settings
"use strict";



// ───────────── overflow menu ─────────────
$("#btn-more").onclick = () => {
  const cur = state.current; const live = !!state.liveInfo[cur.sessionId];
  menuSheet(null, [
    !cur.isNew && { label: "Rename", icon: "edit", run: () => renameSession(cur.sessionId, cur.title) },
    !cur.isNew && { label: state.pinned.includes(cur.sessionId) ? "Unpin" : "Pin", icon: "pin", run: async () => { const r = await conn.call("session.pin", { sessionId: cur.sessionId, pinned: !state.pinned.includes(cur.sessionId) }); state.pinned = r.pinned; renderSessions(); } },
    { label: "Usage and context", icon: "chart", run: openUsage },
    { label: "Commands & skills", icon: "bolt", run: showCommands },
    !cur.isNew && { label: "Fork this chat", icon: "fork", run: () => forkSession(cur.sessionId) },
    !cur.isNew && { label: "Export / share chat", icon: "share", run: () => shareText(`# ${cur.title}\n\n${chat.toMarkdown()}`, cur.title) },
    !cur.isNew && native && !nativeCall("isStandalone") && { label: "Continue in Termux", icon: "terminal", run: () => nativeCall("openInTermux", cur.cwd, cur.sessionId) },
    live && { label: "Stop background process", icon: "stop", run: () => conn.call("session.close", { sessionId: cur.sessionId }) },
    !cur.isNew && { label: "Delete chat", icon: "trash", danger: true, run: () => deleteSession(cur.sessionId, cur.title) },
  ]);
};
$("#title-wrap").onclick = () => { if (!state.current.isNew) renameSession(state.current.sessionId, state.current.title); };
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
// Settings home: a search box and a short list of categories, each showing its current state and opening a
// short page of its own. Searching shows every matching setting from all categories, usable in place.
const FONT_LABEL = { 14: "Small", 15.5: "Default", 17: "Large", 19: "Huge" };
const item = (html, keys = "") => `<div class="set-item" data-keys="${esc(keys)}">${html}</div>`;
const sw = k => `<button class="switch ${settings[k] ? "on" : ""}" data-k="${k}" role="switch" aria-checked="${!!settings[k]}"></button>`;
function settingsSections() {
  const d = state.defaults;
  const standalone = native && nativeCall("isStandalone") === true;
  const mode = MODES.find(m => m.id === (d.permissionMode || "default"));
  return [
    { id: "look", title: "Appearance", icon: "image",
      summary: `${settings.theme === "system" ? "Follows the phone" : settings.theme === "dark" ? "Dark" : "Light"} · ${FONT_LABEL[settings.fontSize] || "Default"} text`,
      html: () => item(`<div class="set-row"><div class="l">Theme</div></div><div class="seg" id="s-theme">${["system", "light", "dark"].map(t => `<button data-v="${t}" class="${settings.theme === t ? "on" : ""}">${t}</button>`).join("")}</div>`, "dark light mode colour")
        + item(`<div class="set-row"><div class="l">Text size</div></div><div class="seg" id="s-font">${[14, 15.5, 17, 19].map(t => `<button data-v="${t}" class="${settings.fontSize == t ? "on" : ""}">${FONT_LABEL[t]}</button>`).join("")}</div>`, "font zoom bigger smaller")
        + item(`<div class="set-row"><div class="l">Show thinking while Claude works</div>${sw("showThinking")}</div>`, "reasoning")
        + item(`<div class="set-row"><div class="l">Group each reply's steps into one line<small>Tap the line for every step. Off: one card per step</small></div>${sw("groupSteps")}</div>`, "tools steps cards timeline progress")
        + item(`<div class="set-row"><div class="l">Expand tool details by default</div>${sw("autoExpandTools")}</div>`, "commands output") },
    { id: "typing", title: "Typing", icon: "pencil",
      summary: `Enter ${settings.enterToSend ? "sends" : "adds a line"} · haptics ${settings.haptics ? "on" : "off"}`,
      html: () => item(`<div class="set-row"><div class="l">Enter sends message<small>Off: Enter adds a new line, tap the arrow to send</small></div>${sw("enterToSend")}</div>`, "keyboard return")
        + item(`<div class="set-row"><div class="l">Haptic feedback</div>${sw("haptics")}</div>`, "vibration vibrate") },
    { id: "notify", title: "Notifications", icon: "bolt",
      summary: [settings.notifyApproval && "approvals", settings.notifyDone && "finished"].filter(Boolean).join(" and ") || "Off",
      html: () => item(`<div class="set-row"><div class="l">When Claude needs approval<small>With Allow / Deny buttons</small></div>${sw("notifyApproval")}</div>`, "permission allow deny")
        + item(`<div class="set-row"><div class="l">When Claude finishes</div>${sw("notifyDone")}</div>`, "done complete") },
    { id: "newchat", title: "New chats", icon: "plan",
      summary: `${shortPath(d.cwd) || "~"} · ${modelLabel(d.model)} · ${mode?.short || "Ask"}`,
      html: () => item(`<div class="set-row"><div class="l">Folder<small id="d-cwd">${esc(shortPath(d.cwd) || "~ (home)")}</small></div><button class="chip" id="d-cwd-btn">Change</button></div>`, "directory project cwd default")
        + item(`<div class="set-row"><div class="l">Model<small>${esc(modelLabel(d.model))}</small></div><button class="chip" id="d-model">Change</button></div>`, "opus sonnet haiku default")
        + item(`<div class="set-row"><div class="l">Effort</div></div><div class="seg" id="d-effort">${["", ...EFFORTS].map(e => `<button data-v="${e}" class="${(d.effort || "") === e ? "on" : ""}">${e || "auto"}</button>`).join("")}</div>`, "thinking reasoning default")
        + item(`<div class="set-row"><div class="l">Permission mode</div></div><div class="seg" id="d-mode">${MODES.slice(0, 4).map(m => `<button data-v="${m.id}" class="${(d.permissionMode || "default") === m.id ? "on" : ""}">${m.short}</button>`).join("")}</div>`, "ask auto bypass plan approvals default") },
    { id: "claude", title: "Claude and connection", icon: "globe",
      summary: `${settings.server ? settings.server.replace(/^https?:\/\//, "") : native ? "Runs on this phone" : location.host}${state.account?.email ? " · " + state.account.email : ""}`,
      html: () => item(`<div class="set-row"><div class="l">Claude runs on<small>${esc(settings.server || (native ? "This phone (built-in)" : location.host))}</small></div><button class="chip" id="s-server">Change</button></div>`, "server termux computer pc remote connection")
        + (standalone ? item(`<div class="set-row"><div class="l">Claude sign-in<small id="s-auth">Checking…</small></div><button class="chip" id="s-login">Sign in again</button></div>`, "login account logout") : "")
        + item(`<div class="set-row"><div class="l">${esc(state.account?.email || state.account?.organization || "Claude account")}<small>${esc(state.account?.subscriptionType || state.account?.apiKeySource || "Signed in through Claude Code")}</small></div></div>`, "account plan subscription")
        + item(`<div class="set-row"><div class="l">Usage limits<small>${esc(usageSummary())}</small></div><button class="chip" id="s-usage">Show</button></div>`, "usage limits quota 5-hour weekly plan")
        + (native ? item(`<div class="set-row"><div class="l">Restart Claude's server<small>Stops any reply in progress</small></div><button class="chip" id="s-restart">Restart</button></div>`, "reload stuck") : "")
        + (standalone ? item(`<div class="set-row"><div class="l">Server log<small>For troubleshooting</small></div><button class="chip" id="s-log">View</button></div>`, "debug errors logs") : "") },
    { id: "updates", title: "Updates", icon: "retry",
      summary: state.updateChannel ? `${state.updateChannel}${state.updateKind === "github" ? " · " + (state.updateTrack?.track === "pin" ? "pinned to " + state.updateTrack.tag : state.updateTrack?.track === "beta" ? "Beta" : "Stable") : ""}` : "Not set",
      html: () => item(`<div class="set-row"><div class="l">Get updates from<small id="u-src">${esc(state.updateChannel ? state.updateChannel + (state.updateKind === "github" && !state.githubToken ? " (no token)" : "") : "Not set: updates come with new app versions")}</small></div><button class="chip" id="u-set">${state.updateChannel ? "Change" : "Set"}</button></div>`, "source github folder")
        + item(`<div class="set-row"><div class="l">Check for updates<small id="u-status">New server code and app screens</small></div><button class="chip" id="u-check">Check</button></div>`, "upgrade new version")
        + (state.updateKind === "github" ? item(`<div class="set-row"><div class="l">Release track<small>${esc(trackLabel(state.updateTrack))}</small></div></div>
          <div class="seg" id="u-track">${[["stable", "Stable"], ["beta", "Beta"], ["pin", "Pinned"]].map(([v, l]) => `<button data-v="${v}" class="${(state.updateTrack?.track || "stable") === v ? "on" : ""}">${l}</button>`).join("")}</div>`, "stable beta pinned channel")
          + item(`<div class="set-row"><div class="l">Versions<small>Every release, with what changed: switch to any of them</small></div><button class="chip" id="u-versions">Open</button></div>`, "releases changelog older") : "") },
    { id: "data", title: "Chats and backups", icon: "folder", summary: "Import, back up, restore",
      html: () => item(`<div class="set-row"><div class="l">Import chats<small>Copy chats from another Pocket Agent server, like Termux</small></div><button class="chip" id="i-chats">Import</button></div>`, "sessions copy termux")
        + item(`<div class="set-row"><div class="l">Back up to phone storage<small>Chats, memory, settings and projects, to Download/Pocket Agent. Not your sign-in.</small></div><button class="chip" id="b-make">Back up</button></div>`, "export save")
        + item(`<div class="set-row"><div class="l">Restore a backup<small>After reinstalling, or on a new phone</small></div><button class="chip" id="b-restore">Restore</button></div>`, "import reinstall") },
    native && { id: "phone", title: "Phone control", icon: "chart", summary: "Permissions and background running",
      html: () => `<div id="phone-ctl">${item(`<div class="set-row"><div class="l">Checking…</div></div>`)}</div>`
        + item(`<div class="set-row"><div class="l">Keep Claude working when you swipe the app away<small>Lock Pocket Agent in recent apps: on vivo, pull its card down; on OnePlus, tap ⋮ on its card, then Lock. If Android still stops it, replies continue when the app comes back.</small></div></div>`, "swipe recents lock killed background keep running") },
    native && { id: "termux", title: "Termux", icon: "terminal", summary: "Optional: commands and setup",
      html: () => `<div id="termux-box">${item(`<div class="set-row"><div class="l">Checking…</div></div>`)}</div>` },
    standalone && { id: "dev", title: "Make it yours", icon: "brain", summary: state.devRepo ? "Improve Pocket Agent" : "Build Pocket Agent yourself",
      html: () => item(`<div class="set-row"><div class="l">Improve Pocket Agent<small>${state.devRepo ? "Start a chat in your copy of the app's code: ask for any change" : "Set up building first (below)"}</small></div><button class="chip" id="d-improve" ${state.devRepo ? "" : "disabled"}>Start</button></div>`, "develop code customise")
        + item(`<div class="set-row"><div class="l">Build Pocket Agent yourself<small>Get the code, Java and the Android build tools, so this app can rebuild itself</small></div><button class="chip" id="d-open">${state.devRepo ? "Redo" : "Set up"}</button></div>`, "developer setup github")
        + item(`<div class="set-row"><div class="l">Move everything from Termux<small>Projects, chats, memory, skills, settings and build tools, into this app</small></div><button class="chip" id="m-open">Open</button></div>`, "migrate") },
    { id: "about", title: "About", icon: "circle", summary: `Pocket Agent ${nativeCall("appVersion") || "web"}`,
      html: () => item(`<div class="set-row"><div class="l">Pocket Agent ${esc(nativeCall("appVersion") || "web")}<small>${standalone ? "Runs Claude Code on this phone" : "Connected to " + esc(settings.server || location.host)}</small></div></div>`, "version") },
  ].filter(Boolean);
}
function openSettings(sectionId) {
  page.open("Settings", body => {
    const secs = settingsSections();
    body.innerHTML = `<div class="settings">
      <input type="search" id="set-q" class="set-search" placeholder="Search settings" aria-label="Search settings" autocomplete="off">
      <nav id="set-home" class="set-cats" aria-label="Settings categories">${secs.map(c => `<button class="set-cat" data-sec="${c.id}">
        <span class="ic" aria-hidden="true">${icon(c.icon)}</span><span class="t">${esc(c.title)}<small>${esc(c.summary)}</small></span><span class="go" aria-hidden="true">›</span></button>`).join("")}</nav>
      <div id="set-results" hidden></div></div>`;
    body.querySelectorAll("[data-sec]").forEach(b => b.onclick = () => openSettingsSection(b.dataset.sec));
    const q = body.querySelector("#set-q"), home = body.querySelector("#set-home"), res = body.querySelector("#set-results");
    q.oninput = () => {
      const t = q.value.trim().toLowerCase();
      home.hidden = !!t; res.hidden = !t;
      if (!t) { res.innerHTML = ""; return; }
      res.innerHTML = secs.map(c => `<section data-sec="${c.id}"><h3>${esc(c.title)}</h3>${c.html()}</section>`).join("");
      wireSettings(res);
      for (const sec of res.querySelectorAll("section")) {
        let any = false;
        for (const it of sec.querySelectorAll(".set-item")) {
          const hit = (it.textContent + " " + it.dataset.keys).toLowerCase().includes(t);
          it.hidden = !hit; any ||= hit;
        }
        // Termux and phone-control rows load asynchronously: match those sections by name instead
        if (!sec.querySelector(".set-item:not([hidden])") && sec.querySelector("#phone-ctl, #termux-box")) any = sec.querySelector("h3").textContent.toLowerCase().includes(t);
        sec.hidden = !any;
      }
      if (![...res.querySelectorAll("section")].some(x => !x.hidden)) res.innerHTML = `<p class="set-none">No setting matches "${esc(q.value.trim())}".</p>`;
    };
  });
  if (sectionId) openSettingsSection(sectionId);
}
function openSettingsSection(id) {
  const c = settingsSections().find(x => x.id === id);
  if (!c) return;
  page.open(c.title, body => { body.innerHTML = `<div class="settings">${c.html()}</div>`; wireSettings(body); });
}
/** Hooks up whatever settings controls are inside root (a category page or search results). */
function wireSettings(root) {
  const d = state.defaults;
  const standalone = native && nativeCall("isStandalone") === true;
  const on = (sel, fn) => root.querySelector(sel)?.addEventListener("click", fn);
  root.querySelectorAll(".switch[data-k]").forEach(b => b.onclick = () => { settings[b.dataset.k] = !settings[b.dataset.k]; b.classList.toggle("on"); b.setAttribute("aria-checked", !!settings[b.dataset.k]); saveSettings(); });
  seg(root, "#s-theme", v => { settings.theme = v; saveSettings(); });
  seg(root, "#s-font", v => { settings.fontSize = +v; saveSettings(); });
  seg(root, "#d-effort", v => setDefaults({ effort: v || null }));
  seg(root, "#d-mode", v => setDefaults({ permissionMode: v }));
  on("#d-cwd-btn", async () => { const p = await pickFolder(d.cwd); if (p) { await setDefaults({ cwd: p }); const el = root.querySelector("#d-cwd"); if (el) el.textContent = shortPath(p); } });
  on("#d-model", () => {
    const b = sheet.open(`<h2>Default model</h2><div id="dm"></div>`);
    for (const m of [{ value: null, displayName: "Claude Code default", description: "Whatever your Claude Code settings use" }, ...state.models]) {
      const o = h(`<button class="opt">${icon("circle")}<div class="ot"><div>${esc(m.displayName)}</div><div class="od">${esc(m.description || "")}</div></div></button>`);
      o.onclick = () => { sheet.close(true); setDefaults({ model: m.value }).then(openSettingsRefresh); };
      b.querySelector("#dm").append(o);
    }
  });
  on("#s-server", () => chooseServer());
  on("#u-set", () => chooseUpdateSource());
  on("#d-open", () => openDevSetup());
  on("#d-improve", () => startImprove());
  on("#b-make", () => makeBackup());
  on("#b-restore", () => chooseBackup());
  on("#u-check", () => checkServerUpdate(true));
  on("#u-versions", () => openVersions());
  root.querySelectorAll("#u-track button").forEach(b => b.onclick = () => b.dataset.v === "pin" ? openVersions() : setTrack({ track: b.dataset.v }));
  on("#m-open", () => openMigration());
  on("#i-chats", async () => {
    const src = await askOtherServer("Import chats from", "Copies that server's chats here. Nothing is deleted on either side; their project folders are created here empty.");
    if (!src) return;
    toast("Importing chats…", 8000);
    try {
      const r = await conn.call("sessions.import", src);
      toast(`Imported ${r.added} new chat${r.added === 1 ? "" : "s"}${r.updated ? `, updated ${r.updated}` : ""}`, 4000);
      refreshSessions();
    } catch (e) { toast(e.message, 5000); }
  });
  on("#s-login", () => nativeCall("openSetup", "#login"));
  on("#s-usage", () => openUsage());
  on("#s-log", () => page.open("Server log", async b => {
    b.className = "viewer"; b.append(codeBlock(await nativeRpc("runtime.logs", { which: "server", bytes: 40000 }).catch(e => e.message) || "(empty)"));
  }));
  if (standalone && root.querySelector("#s-auth")) nativeRpc("runtime.auth").then(a => { const el = root.querySelector("#s-auth"); if (el) el.textContent = a.loggedIn ? [a.email, a.subscriptionType].filter(Boolean).join(" · ") : "Not signed in"; }).catch(() => {});
  on("#s-restart", async () => { try { await conn.call("working.clear"); } catch {} nativeCall("restartServer"); toast("Restarting server…"); });
  if (native && root.querySelector("#phone-ctl")) renderPhoneControl(root.querySelector("#phone-ctl"));
  if (native && root.querySelector("#termux-box")) renderTermux(root.querySelector("#termux-box"));
}
/** Re-renders the settings page on screen (home or a category) so it shows changed values. */
function openSettingsRefresh() {
  const top = page.stack[page.stack.length - 1];
  if (!top || $("#page").hidden) return openSettings();
  const body = $("#page-body"); body.innerHTML = ""; top.render(body);
}

/** What Claude may do on this phone; each row opens the matching Android setting. */
async function renderPhoneControl(box) {
  if (!box) return;
  let p;
  try { p = await nativeRpc("permissions.check", { names: [] }); }
  catch { box.innerHTML = `<div class="set-row"><div class="l">Needs the latest app<small>Install pocket-agent.apk from Downloads/claude apps</small></div></div>`; return; }
  const rows = [
    p.battery !== undefined && ["battery", "Keep running in the background", "So Android doesn't stop Claude in the middle of a reply", p.battery],
    ["accessibility", "Screen control", "Lets Claude read the screen, tap and type when you ask (Accessibility)", p.accessibility],
    ["notification_access", "Read notifications", "Lets Claude read your notifications when you ask", p.notificationAccess],
    ["notifications", "Pocket Agent notifications", "Approvals and progress", p.notifications],
    ["unknown_sources", "One-tap app updates", "Allow Pocket Agent to install its own updates", p.installPackages],
  ];
  box.innerHTML = rows.filter(Boolean).map(([screen, title, sub, on]) =>
    `<div class="set-row"><div class="l">${esc(title)}<small>${esc(sub)}</small></div><button class="chip ${on ? "" : "warn"}" data-screen="${screen}">${on ? "On" : "Turn on"}</button></div>`).join("");
  box.querySelectorAll("[data-screen]").forEach(b => b.onclick = () => (b.dataset.screen === "battery" ? nativeRpc("battery.request") : nativeRpc("settings.open", { screen: b.dataset.screen })).catch(e => toast(e.message)));
}

// ───────────── Termux ─────────────
const TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND";
/** Termux is optional: Claude in the app can run commands there, or the whole server can run there. */
async function renderTermux(box) {
  if (!box) return;
  let st;
  try { st = await nativeRpc("termux.status"); }
  catch { box.innerHTML = `<div class="set-row"><div class="l">Needs the latest app<small>Update Pocket Agent to use Termux</small></div></div>`; return; }
  if (!st.installed) { box.innerHTML = `<div class="set-row"><div class="l">Termux isn't installed<small>Optional. With Termux (from F-Droid or GitHub), Claude can use its packages, and you can run Claude there instead.</small></div></div>`; return; }
  box.innerHTML = `
    <div class="set-row"><div class="l">Termux commands<small>Lets Claude run commands in Termux with <code>termux …</code></small></div><button class="chip ${st.permission ? "" : "warn"}" id="t-perm">${st.permission ? "Allowed" : "Allow"}</button></div>
    <div class="set-row"><div class="l">Set up Termux<small>One command: Claude Code, the Pocket Agent server, and access for the app</small></div><button class="chip" id="t-setup">Open</button></div>
    <div class="set-row"><div class="l">Test<small id="t-test-r">Runs <code>uname -a</code> in Termux</small></div><button class="chip" id="t-test">Run</button></div>`;
  box.querySelector("#t-perm").onclick = async () => {
    try { await nativeRpc("permissions.request", { names: [TERMUX_PERMISSION] }); } catch (e) { return toast(e.message); }
    renderTermux(box);
  };
  box.querySelector("#t-setup").onclick = () => termuxSetupSheet();
  box.querySelector("#t-test").onclick = async () => {
    const out = box.querySelector("#t-test-r"); out.textContent = "Running…";
    try { const r = await nativeRpc("termux.exec", { cmd: "uname -a", timeoutMs: 20000 }); out.textContent = (r.stdout || r.stderr || "exit " + r.code).trim(); }
    catch (e) { out.textContent = e.message; }
  };
}
async function termuxSetupSheet() {
  let cmd;
  try { cmd = (await conn.call("termux.installCommand")).command; } catch (e) { return toast(e.message, 5000); }
  const b = sheet.open(`<h2>Set up Termux</h2>
    <div class="sub">Paste this into Termux and press Enter. It installs Claude Code and the Pocket Agent server there, and lets this app run commands in Termux. About 5 minutes and 400 MB. The command works for 30 minutes.</div>
    <pre style="font:12px/1.5 var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all">${esc(cmd)}</pre>
    <div class="btns"><button class="btn" id="ts-copy">Copy</button><button class="btn primary" id="ts-open">Copy and open Termux</button></div>`);
  const copy = () => nativeRpc("clipboard.set", { text: cmd }).catch(() => navigator.clipboard?.writeText(cmd)).then(() => toast("Copied"));
  b.querySelector("#ts-copy").onclick = copy;
  b.querySelector("#ts-open").onclick = async () => { await copy(); nativeRpc("app.launch", { package: "com.termux" }).catch(e => toast(e.message)); };
}

// ───────────── backups ─────────────
async function makeBackup() {
  if (native) await nativeRpc("permissions.request", { names: ["android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"] }).catch(() => {});
  showBanner("Backing up… this can take a minute.");
  try {
    const r = await conn.call("backup.create");
    hideBanner(); toast(`Saved ${r.file.replace("/sdcard/", "")} (${(r.bytes / 1e6).toFixed(0)} MB)`, 6000);
  } catch (e) { hideBanner(); toast(e.message, 6000); }
}
async function chooseBackup() {
  if (native) await nativeRpc("permissions.request", { names: ["android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"] }).catch(() => {});
  let r; try { r = await conn.call("backup.list"); } catch (e) { return toast(e.message); }
  const b = sheet.open(`<h2>Restore a backup</h2><div class="sub">From ${esc(r.dir.replace("/sdcard/", ""))}. Files in the backup replace the same files here; nothing else is deleted. Sign in to Claude stays as it is.</div><div id="bk"></div>`);
  if (!r.backups.length) b.querySelector("#bk").innerHTML = `<div class="sub">No backups found there.</div>`;
  for (const k of r.backups) {
    const o = h(`<button class="opt">${icon("folder")}<div class="ot"><div>${esc(new Date(k.at).toLocaleString())}</div><div class="od">${esc(k.name)} · ${(k.bytes / 1e6).toFixed(0)} MB</div></div></button>`);
    o.onclick = async () => {
      sheet.close(true);
      showBanner("Restoring… Pocket Agent restarts afterwards.");
      try { await conn.call("backup.restore", { file: k.file }); state.updating = true; toast("Restored", 4000); refreshSessions(); }
      catch (e) { hideBanner(); toast(e.message, 6000); }
    };
    b.querySelector("#bk").append(o);
  }
}

// ───────────── improving the app itself ─────────────
const IMPROVE_PROMPT = "I want to work on my own version of Pocket Agent, this app. Read CLAUDE.md first. Then tell me in a few lines where things stand: my branch, uncommitted work, and whether the shared v1.x line has changes I don't have yet. Then ask what I'd like to change.";
function startImprove() {
  if (!state.devRepo) return openDevSetup();
  page.close(); sheet.close(true);
  newChat(state.devRepo);
  send(IMPROVE_PROMPT);
}
/** Where Claude runs: the app's built-in Linux, or another Pocket Agent server (Termux, a PC). */
function chooseServer() {
  const b = sheet.open(`<h2>Where Claude runs</h2><div class="sub">Chats live with the server they were made on.</div><div id="srv-opts"></div>`);
  const opts = [
    native && { id: "", title: "This phone (built-in)", sub: "Pocket Agent's own Linux; works offline from Termux" },
    { id: "custom", title: "Another server…", sub: "Pocket Agent server in Termux or on a computer" },
  ].filter(Boolean);
  for (const o of opts) {
    const on = (o.id === "" && !settings.server) || (o.id === "custom" && settings.server);
    const el = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div>${esc(o.title)}</div><div class="od">${esc(o.sub)}</div></div></button>`);
    el.onclick = async () => {
      sheet.close(true);
      let server = "", token = "";
      if (o.id === "custom") {
        server = await promptSheet({ title: "Server address", value: settings.server || "http://127.0.0.1:8765", placeholder: "http://host:8765" });
        if (!server) return;
        token = await promptSheet({ title: "Server token", value: settings.token, placeholder: "Run \`pocket-agent token\` on the server" });
        if (token === null) return;
      }
      settings.server = server.replace(/\/$/, ""); settings.token = token.trim(); saveSettings();
      toast("Switching…");
      if (native) nativeRpc("mode.set", { server: settings.server, token: settings.token }).catch(e => toast(e.message));
      else { conn.ws?.close(); openSettingsRefresh(); }
    };
    b.querySelector("#srv-opts").append(el);
  }
}
/** Address + token of another Pocket Agent server (defaults to Termux on this phone); remembered for next time. */
async function askOtherServer(title, text) {
  const url = await promptSheet({ title, value: settings.otherServer || "http://127.0.0.1:8765", placeholder: "http://host:8765" });
  if (!url) return null;
  const token = await promptSheet({ title: "Token for " + url.replace(/^https?:\/\//, ""), value: settings.otherToken || "", placeholder: "In Termux: pocket-agent token" });
  if (token === null) return null;
  settings.otherServer = url.trim().replace(/\/$/, ""); settings.otherToken = token.trim(); saveSettings();
  return { url: settings.otherServer, token: settings.otherToken };
}
// ───────────── release tracks and versions (GitHub releases) ─────────────
function trackLabel(t) {
  if (t?.track === "beta") return "Beta: the newest release, including test versions";
  if (t?.track === "pin") return `Pinned to ${t.tag}: no updates until you choose another`;
  return "Stable: the newest full release";
}
async function setTrack(t) {
  try { state.updateTrack = (await conn.call("update.track", t)).track; } catch (e) { return toast(e.message, 5000); }
  openSettingsRefresh();
  toast(trackLabel(state.updateTrack), 3000);
  checkAppUpdate(); checkServerUpdate(true);
}
/** All releases, newest first; any of them can be chosen, older ones too (screens and server only). */
async function openVersions() {
  let r; try { r = await conn.call("releases.list"); } catch (e) { return toast(e.message, 5000); }
  const app = nativeCall("appVersion") || "";
  page.open("Versions", body => {
    body.innerHTML = `<div class="settings">
      <div class="sub" style="margin:12px 0">You're on <b>${esc(r.current.version)}</b> (build ${r.current.build})${app ? ` · app ${esc(app)}` : ""}. ${esc(trackLabel(r.track))}.</div>
      <div id="vers"></div></div>`;
    const box = body.querySelector("#vers");
    if (!r.releases.length) box.innerHTML = `<div class="sub">No releases yet.</div>`;
    for (const rel of r.releases) {
      const isPinned = r.track.track === "pin" && r.track.tag === rel.tag;
      const notes = rel.notes.split("\n").filter(l => l.trim()).slice(0, 6).join("\n");
      const el = h(`<div class="set-row" style="align-items:flex-start"><div class="l">${esc(rel.tag)}${rel.prerelease ? ' <span class="chip">beta</span>' : ""}${isPinned ? ' <span class="chip">pinned</span>' : ""}
        <small>${esc(new Date(rel.publishedAt).toLocaleDateString())}</small><small style="white-space:pre-wrap">${esc(notes)}</small></div>
        <button class="chip">Use</button></div>`);
      el.querySelector("button").onclick = () => switchVersion(rel);
      box.append(el);
    }
  });
}
async function switchVersion(rel) {
  const ok = await confirmSheet({ title: `Use ${rel.tag}?`, ok: "Switch",
    text: `Pocket Agent stays on ${rel.tag} until you pick Stable, Beta or another version here. Screens and the server switch now; if this release has a newer app, you'll be offered it. An older release keeps your current app: Android can't install an older app over a newer one.` });
  if (!ok) return;
  try { state.updateTrack = (await conn.call("update.track", { track: "pin", tag: rel.tag })).track; } catch (e) { return toast(e.message, 5000); }
  page.close();
  checkAppUpdate();
  checkServerUpdate(true);
}

/** Checks the update source; offers to apply. quiet=false also reports "up to date" and errors. */
async function checkServerUpdate(loud) {
  try {
    const r = await conn.call("update.check", loud ? { fresh: true } : {});   // the button skips the 2-minute cache
    if (!r.channel) { if (loud) toast("Set where updates come from first"); return; }
    if (r.older) { if (loud) toast(`${r.channel} has older code (build ${r.remote.build}) than this app (build ${r.local.build}). Not updating.`, 6000); return; }
    if (!r.available) { if (loud) toast("Up to date"); return; }
    showBanner("An update is ready for Pocket Agent", "Update", applyServerUpdate);
    if (loud) applyServerUpdate();
  } catch (e) { if (loud) toast(e.message, 5000); }
}
async function applyServerUpdate() {
  showBanner("Updating… Pocket Agent restarts when no reply is in progress.");
  state.updating = true;
  try {
    const r = await conn.call("update.apply");
    if (r.upToDate) { state.updating = false; hideBanner(); toast("Up to date"); }
  } catch (e) {
    // The server restarting with the update drops the connection before or right after it answers.
    if (e.message === "Disconnected") return;
    state.updating = false; hideBanner(); toast(e.message, 5000);
  }
}
/** Where server code, screens and new APKs come from. */
function chooseUpdateSource() {
  const b = sheet.open(`<h2>Get updates from</h2><div class="sub">Pocket Agent checks this for new server code, screens and app versions.</div><div id="us-opts"></div>`);
  const opts = [
    { id: "github", title: "GitHub releases", sub: (state.defaultRepo ? state.defaultRepo + ". " : "") + "Only what's deliberately released. Private repos need a token." },
    { id: "server", title: "Another Pocket Agent server", sub: "e.g. Termux on this phone, or a computer" },
    native && { id: "path", title: "A project folder on this phone", sub: "For developing Pocket Agent here (~/projects/pocket-agent)" },
    { id: "none", title: "None", sub: "Update only by installing new APKs" },
  ].filter(Boolean);
  for (const o of opts) {
    const on = (state.updateKind || "none") === o.id;
    const el = h(`<button class="opt ${on ? "on" : ""}">${icon(on ? "ccheck" : "circle")}<div class="ot"><div>${esc(o.title)}</div><div class="od">${esc(o.sub)}</div></div></button>`);
    el.onclick = async () => {
      sheet.close(true);
      let src = {};
      if (o.id === "github") {
        const repo = await promptSheet({ title: "GitHub repository", value: state.updateKind === "github" ? state.updateChannel.replace("github.com/", "") : state.defaultRepo || "", placeholder: "owner/pocket-agent" });
        if (!repo) return;
        const token = await promptSheet({ title: "GitHub token (for private repos)", value: "", ok: "Save",
          placeholder: "Paste a read-only token, or leave empty for a public repo" });
        if (token === null) return;
        src = { github: repo.trim(), token: token.trim() };
      } else if (o.id === "server") { src = await askOtherServer("Get updates from", ""); if (!src) return; }
      else if (o.id === "path") { const p = await pickFolder(state.home + "/projects/pocket-agent"); if (!p) return; src = { path: p }; }
      try {
        const r = await conn.call("update.channel", src);
        Object.assign(state, { updateChannel: r.channel, updateKind: o.id === "none" ? null : o.id, githubToken: !!src.token });
        toast(r.channel ? "Update source saved" : "Updates turned off");
        openSettingsRefresh();
        if (r.channel) checkServerUpdate(true);
      } catch (e) { toast(e.message, 5000); }
    };
    b.querySelector("#us-opts").append(el);
  }
}

// ───── background jobs: move from Termux, build it yourself ─────
const jobs = { migrate: null, devsetup: null };
conn.on("migrate", m => { jobs.migrate = m.job; renderJob("migrate"); });
conn.on("devsetup", m => { jobs.devsetup = m.job; renderJob("devsetup"); });
const JOB_DEFS = {
  migrate: {
    title: "Move from Termux", status: "migrate.status", start: "migrate.run",
    steps: [["download", "Download from Termux"], ["files", "Projects, chats, memory, skills, settings"], ["paths", "Map old Termux paths to your home folder"],
      ["tools", "Java and Android build tools"], ["deps", "Project dependencies"], ["done", "Done"]],
    intro: `<p>Copies your Termux home into this app: <b>~/projects</b> and your other folders, Claude's chats, memory, skills, plugins and settings, and SSH keys. Then it installs Java and the Android build tools. Nothing in Termux is changed or deleted.</p>
      <p>Termux must be running its server (<code>pocket-agent start</code>). Takes 5 to 15 minutes; keep the app open.</p>`,
    ask: () => askOtherServer("Move from", ""),
    done: j => `Moved. Your projects are in <b>~/projects</b>, chats are in the list, and old Termux paths point here.${j.summary?.tools ? " The app can now build APKs." : ""}`,
  },
  devsetup: {
    title: "Build Pocket Agent yourself", status: "dev.status", start: "dev.setup",
    steps: [["tools", "Java 17, aapt2, zipalign, d8, apksigner"], ["code", "Get the code"], ["sdk", "Android 14 platform (android.jar)"], ["deps", "Node packages"], ["build", "Test build"], ["done", "Done"]],
    intro: `<p>Sets up this app to build Pocket Agent from source, with no computer and no Termux: installs the build tools, clones the repository into <b>~/projects</b>, downloads the Android platform and builds once.</p>
      <p>Afterwards, ask Claude to change Pocket Agent; screen and server changes apply with <b>Check for updates</b>, new APKs through the update banner. Takes 5 to 15 minutes and about 600 MB.</p>`,
    ask: async () => {
      const repo = await promptSheet({ title: "Repository", value: state.defaultRepo || "", placeholder: "owner/pocket-agent or https://…" });
      if (!repo) return null;
      const token = await promptSheet({ title: "GitHub token", value: "", placeholder: "Contents: read and write, to save and share your changes", ok: "Start" });
      return token === null ? null : { repo: repo.trim(), token: token.trim() };
    },
    done: j => `Ready. Your copy of the code is in <b>${esc((j.summary?.path || "").replace(state.home, "~"))}</b>, and the app now updates from it.<div class="btns"><button class="btn primary" data-act="improve">Start improving Pocket Agent</button></div>`,
  },
};
function openMigration() { openJob("migrate"); }
function openDevSetup() { openJob("devsetup"); }
function openJob(kind) {
  const def = JOB_DEFS[kind];
  page.open(def.title, async body => {
    body.innerHTML = `<div class="settings" id="job-${kind}">
      <div style="color:var(--muted);margin:14px 0">${def.intro}</div>
      <div class="job-steps"></div><pre class="job-log" style="font:11px/1.5 var(--mono);color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:40vh;overflow:auto;white-space:pre-wrap" hidden></pre>
      <div class="job-result"></div>
      <div class="btns"><button class="btn primary job-start">Start</button></div></div>`;
    body.querySelector(".job-start").onclick = async () => {
      const args = await def.ask(); if (!args) return;
      try { jobs[kind] = (await conn.call(def.start, args)).job; renderJob(kind); } catch (e) { toast(e.message, 6000); }
    };
    try { jobs[kind] = (await conn.call(def.status)).job; } catch {}
    renderJob(kind);
  });
}
function renderJob(kind) {
  const box = document.getElementById("job-" + kind), j = jobs[kind], def = JOB_DEFS[kind];
  if (!box || !j) return;
  const idx = def.steps.findIndex(x => x[0] === j.step), started = j.running || j.done || j.error;
  box.querySelector(".job-steps").innerHTML = started ? def.steps.map(([id, name], i) => {
    const st = j.done || i < idx ? "done" : i === idx ? (j.error ? "err" : "run") : "wait";
    return `<div class="set-row"><div class="l" style="${st === "wait" ? "color:var(--faint)" : ""}">${esc(name)}</div><span>${st === "run" ? '<span class="spark"></span>' : st === "done" ? icon("check") : st === "err" ? icon("x") : ""}</span></div>`;
  }).join("") : "";
  const log = box.querySelector(".job-log");
  if (started) { log.hidden = false; log.textContent = (j.lines || []).join("\n"); log.scrollTop = log.scrollHeight; }
  const btn = box.querySelector(".job-start");
  btn.hidden = !!j.running || !!j.done; btn.textContent = j.error ? "Try again" : "Start";
  const res = box.querySelector(".job-result");
  if (j.error) res.innerHTML = `<div class="note err">${esc(j.error)}</div>`;
  else if (j.done) {
    res.innerHTML = `<div class="note" style="font-family:var(--sans)">${def.done(j)}</div>${(j.summary?.warnings || []).map(x => `<div class="note err">${esc(x)}</div>`).join("")}`;
    res.querySelector("[data-act=improve]")?.addEventListener("click", () => { state.devRepo = j.summary?.path || state.devRepo; startImprove(); });
    refreshSessions();
  }
}

function seg(root, sel, fn) { root.querySelectorAll(sel + " button").forEach(b => b.onclick = () => { root.querySelectorAll(sel + " button").forEach(x => x.classList.remove("on")); b.classList.add("on"); fn(b.dataset.v); }); }
async function setDefaults(patch) {
  try { const r = await conn.call("defaults.set", { defaults: patch }); state.defaults = r.defaults; if (state.current?.isNew) { Object.assign(state.current, patch); updateComposer(); } } catch (e) { toast(e.message); }
}
