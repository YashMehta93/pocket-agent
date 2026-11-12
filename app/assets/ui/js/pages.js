// pages.js — overflow menu, context usage, commands list, file browser, folder picker, settings
"use strict";



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
    !cur.isNew && native && !nativeCall("isStandalone") && { label: "Continue in Termux", icon: "terminal", run: () => nativeCall("openInTermux", cur.cwd, cur.sessionId) },
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
    const standalone = native && nativeCall("isStandalone") === true;
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
      <div class="set-row"><div class="l">Claude runs on<small>${esc(settings.server || (native ? "This phone (built-in)" : location.host))}</small></div><button class="chip" id="s-server">Change</button></div>
      ${native ? `<div class="set-row"><div class="l">Restart Claude's server<small>Stops any reply in progress</small></div><button class="chip" id="s-restart">Restart</button></div>` : ""}
      ${standalone ? `<div class="set-row"><div class="l">Claude sign-in<small id="s-auth">Checking…</small></div><button class="chip" id="s-login">Sign in again</button></div>
      <div class="set-row"><div class="l">Server log<small>For troubleshooting</small></div><button class="chip" id="s-log">View</button></div>` : ""}
      ${native ? `<h3>Phone control</h3><div id="phone-ctl"><div class="set-row"><div class="l">Checking…</div></div></div>` : ""}
      <h3>Account</h3>
      <div class="set-row"><div class="l">${esc(state.account?.email || state.account?.organization || "Claude account")}<small>${esc(state.account?.subscriptionType || state.account?.apiKeySource || "Signed in through Claude Code")}</small></div></div>
      <h3>About</h3>
      <div class="set-row"><div class="l">Pocket Agent ${esc(nativeCall("appVersion") || "web")}<small>${standalone ? "Runs Claude Code on this phone" : "Connected to " + esc(settings.server || location.host)}</small></div></div>
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
    body.querySelector("#s-server").onclick = () => chooseServer();
    body.querySelector("#s-login")?.addEventListener("click", () => nativeCall("openSetup", "#login"));
    body.querySelector("#s-log")?.addEventListener("click", () => page.open("Server log", async b => {
      b.className = "viewer"; b.append(codeBlock(await nativeRpc("runtime.logs", { which: "server", bytes: 40000 }).catch(e => e.message) || "(empty)"));
    }));
    if (standalone) nativeRpc("runtime.auth").then(a => { const el = body.querySelector("#s-auth"); if (el) el.textContent = a.loggedIn ? [a.email, a.subscriptionType].filter(Boolean).join(" · ") : "Not signed in"; }).catch(() => {});
    body.querySelector("#s-restart")?.addEventListener("click", () => { nativeCall("restartServer"); toast("Restarting server…"); });
    if (native) renderPhoneControl(body.querySelector("#phone-ctl"));
  });
}

/** What Claude may do on this phone; each row opens the matching Android setting. */
async function renderPhoneControl(box) {
  if (!box) return;
  let p;
  try { p = await nativeRpc("permissions.check", { names: [] }); }
  catch { box.innerHTML = `<div class="set-row"><div class="l">Needs the latest app<small>Install pocket-agent.apk from Downloads/claude apps</small></div></div>`; return; }
  const rows = [
    ["accessibility", "Screen control", "Lets Claude read the screen, tap and type when you ask (Accessibility)", p.accessibility],
    ["notification_access", "Read notifications", "Lets Claude read your notifications when you ask", p.notificationAccess],
    ["notifications", "Pocket Agent notifications", "Approvals and progress", p.notifications],
    ["unknown_sources", "One-tap app updates", "Allow Pocket Agent to install its own updates", p.installPackages],
  ];
  box.innerHTML = rows.map(([screen, title, sub, on]) =>
    `<div class="set-row"><div class="l">${esc(title)}<small>${esc(sub)}</small></div><button class="chip ${on ? "" : "warn"}" data-screen="${screen}">${on ? "On" : "Turn on"}</button></div>`).join("");
  box.querySelectorAll("[data-screen]").forEach(b => b.onclick = () => nativeRpc("settings.open", { screen: b.dataset.screen }).catch(e => toast(e.message)));
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
function openSettingsRefresh() { page.close(); openSettings(); }
function seg(root, sel, fn) { root.querySelectorAll(sel + " button").forEach(b => b.onclick = () => { root.querySelectorAll(sel + " button").forEach(x => x.classList.remove("on")); b.classList.add("on"); fn(b.dataset.v); }); }
async function setDefaults(patch) {
  try { const r = await conn.call("defaults.set", { defaults: patch }); state.defaults = r.defaults; if (state.current?.isNew) { Object.assign(state.current, patch); updateComposer(); } } catch (e) { toast(e.message); }
}
