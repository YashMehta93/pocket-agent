// Screen test for Profiles (#68): Settings → Profiles (the list, one profile's editor, colours, folders, the Claude
// account, environment variables, saving, and errors next to their field), the drawer's filter with two profiles,
// profile dots, a worker following its parent, the header's profile and a new chat's profile chip.
// It starts its own throwaway server with its own HOME / PA_DATA and a free port, so the app's server, data and
// port are never touched. No network, no Claude (a stand-in is on PATH for the server).
//   npm run test:profiles-ui
import { JSDOM, VirtualConsole } from "jsdom";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = process.env.PA_PROFILES_PORT ? Number(process.env.PA_PROFILES_PORT)
  : await new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pa-profiles-ui-"));
const HOME = path.join(T, "home"), DATA = path.join(HOME, ".pocket-agent");
const A = path.join(T, "A"), Asub = path.join(A, "sub"), B = path.join(T, "B");
fs.mkdirSync(DATA, { recursive: true });
for (const d of [Asub, B]) fs.mkdirSync(d, { recursive: true });
// A stand-in for Claude Code, so nothing here can start the real one (config.js would find it on PATH).
const FAKE = path.join(T, "fakeclaude.sh");
fs.writeFileSync(FAKE, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
const env = { ...process.env, HOME, PA_DATA: DATA, PA_CLAUDE: FAKE, PA_PORT: String(PORT) };
for (const k of ["CLAUDE_CONFIG_DIR", "PA_SUPERVISED", "PA_MODE"]) delete env[k];
const srvLog = path.join(T, "server.log");
const srvOut = fs.openSync(srvLog, "w");
const server = spawn(process.execPath, [path.join(REPO, "server/src/index.js"), "--port", String(PORT)], { env, stdio: ["ignore", srvOut, srvOut] });
fs.closeSync(srvOut);

let fails = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(80); }
  throw new Error("timeout: " + what);
}
const healthy = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; } };

try {
  await until(async () => server.exitCode === null && await healthy(), 20000, "server")
    .catch(e => { throw new Error(e.message + "\n" + fs.readFileSync(srvLog, "utf8").slice(-2000)); });
  const token = fs.readFileSync(path.join(DATA, "token"), "utf8").trim();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push("jsdomError: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
  vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ").slice(0, 300)));
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/ui/#token=${token}`, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: true, addEventListener() {} });
      w.ResizeObserver = class { observe() {} };
      w.HTMLElement.prototype.scrollIntoView = () => {};
      if (!w.crypto.randomUUID) w.crypto.randomUUID = () => crypto.randomUUID();
    },
  });
  const w = dom.window, ev = s => w.eval(s);
  const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];
  const tx = s => ((typeof s === "string" ? $(s) : s)?.textContent || "").replace(/\s+/g, " ").trim();
  const openProfile = async name => {
    const row = $$("#page-body .prof-row").find(r => r.textContent.includes(name));
    if (!row) throw new Error("no profile row: " + name);
    row.click(); await until(() => $("#pf-name"));
  };
  const setPick = p => ev(`pickFolder = () => Promise.resolve(${JSON.stringify(p)})`);

  await new Promise(r => w.addEventListener("load", r));
  await until(() => ev("conn.ok") && ev("state.profiles")?.length === 1, 20000, "connect + hello");

  // ───── one profile: exactly as before, plus one Settings row ─────
  ok("one implicit profile: Personal, and no drawer filter row",
    ev("state.profiles[0].name") === "Personal" && ev("state.defaultProfile") === "personal" && $("#profile-filters").hidden);
  ev("openSettings()");
  const cat = $('[data-sec="profiles"]');
  ok(`Settings has a Profiles row: "${tx(cat?.querySelector("small"))}"`, !!cat && tx(cat).includes("Profiles") && tx(cat.querySelector("small")).includes("Personal"));
  cat.click();
  ok(`the profiles page lists it, with its folder count and account: "${tx("#page-body .prof-row small")}"`,
    $$("#page-body .prof-row").length === 1 && /No folders · /.test(tx("#page-body .prof-row small")) && !/Default/.test(tx("#page-body .prof-row")) && !!$("#page-body #prof-new"));

  await openProfile("Personal");
  ok("one profile's editor: name, 7 colours (teal ringed), the account and env hint",
    $("#pf-name").value === "Personal" && $$("#page-body .pf-sw").length === 7 && $$("#page-body .pf-sw.on").length === 1
    && $("#page-body .pf-sw.on").classList.contains("pc-teal") && /Use \$SECRETS for this profile's secrets folder\./.test(tx("#page-body .pf-hint"))
    && $("#page-body .pf-env").value === "" && !!$("#pf-save"));
  ok("the only profile has neither Make default nor Delete", !$("#pf-default") && !$("#pf-delete"));

  setPick(A);
  $("#pf-add").click();
  await until(() => $$("#page-body .pf-folder").length === 1);
  ok("Add folder uses the app's folder picker", tx("#page-body .pf-folder .l") === ev(`shortPath(${JSON.stringify(A)})`) && !!$("#page-body .pf-folder .pf-x"));
  $("#pf-save").click();
  await until(() => ev("state.profiles.find(p => p.id === 'personal').workspaces.length") === 1, 10000, "save");
  ok(`saving returns to the list, now "1 folder": "${tx("#page-body .prof-row small")}"`,
    $("#page-title").textContent === "Profiles" && /^1 folder · /.test(tx("#page-body .prof-row small")));
  const saved = await ev('conn.call("profiles.list")');
  ok("the server has the folder", saved.profiles[0].workspaces[0] === A);

  // ───── a new profile: colour, folder, account, env, and Save ─────
  $("#prof-new").click();
  await until(() => $("#pf-name"));
  ok("New profile opens an empty editor", $("#page-title").textContent === "New profile" && $("#pf-name").value === "" && $$("#page-body .pf-sw.on").length === 1);
  $("#pf-name").value = "Work";
  $("#pf-name").dispatchEvent(new w.Event("input"));
  $$("#page-body .pf-sw").find(b => b.dataset.color === "blue").click();
  ok("a colour can be chosen, and the chosen one is ringed", $$("#page-body .pf-sw.on").length === 1 && $("#page-body .pf-sw.on").classList.contains("pc-blue"));
  setPick(Asub);
  $("#pf-add").click();
  await until(() => $$("#page-body .pf-folder").length === 1);
  $("#pf-env").value = "TOKEN_FILE=$SECRETS/token\nSITE=work";
  $("#pf-save").click();
  await until(() => ev("state.profiles.length") === 2, 10000, "second profile");
  const work = await ev(`(() => { const p = state.profiles.find(x => x.name === "Work");
    return p && { id: p.id, color: p.color, workspaces: p.workspaces, env: p.env, accounts: p.accounts }; })()`);
  ok("the new profile is saved with its colour, folder and env",
    work?.id === "work" && work.color === "blue" && work.workspaces[0] === Asub && work.env.SITE === "work" && work.env.TOKEN_FILE === "$SECRETS/token" && Object.keys(work.accounts || {}).length === 0);
  ok(`the page now lists both, and the Settings value line names them: "${tx("#page-body .prof-row")}"`,
    $$("#page-body .prof-row").length === 2 && !/Default/.test(tx("#page-body")) && /^1 folder · .*/.test(tx($$("#page-body .prof-row")[1].querySelector("small"))));
  ev("page.back()");
  ok("Settings → Profiles' value line lists the names", tx('[data-sec="profiles"] small') === "Personal, Work");
  ev(`const q = $("#set-q"); q.value = "profiles"; q.dispatchEvent(new window.Event("input"))`);
  ok("settings search finds Profiles, with the profiles and New profile",
    /Profiles/.test(tx("#set-results")) && !$('#set-results [data-sec="profiles"]').hidden && /New profile/.test(tx('#set-results [data-sec="profiles"]')));

  // ───── the Claude account: real names, the app default marked ─────
  ev(`page.close(); openSettings()`);
  $('[data-sec="profiles"]').click();
  await until(() => $$("#page-body .prof-row").length === 2);
  const added = await ev('conn.call("accounts.add", { name: "Work login" })');
  ev(`state.accounts = [...state.accounts, ${JSON.stringify(added.account)}, { id: "fake-x", name: "Default", email: "w@example.com", plan: null }]`);
  $$("#page-body .prof-row").find(r => r.textContent.includes("Work")).click();
  await until(() => $("#pf-account-btn"));
  ok(`the account row shows the app default by a real name, marked: "${tx("#pf-account")}"`,
    /\(app default\)/.test(tx("#pf-account")) && !/^Default/.test(tx("#pf-account")));
  $("#pf-account-btn").click();
  const opts = $$("#sheet .opt");
  ok(`the account sheet lists real names, never "Default": "${opts.map(o => o.querySelector(".ot div").textContent).join(" / ")}"`,
    opts.length === 3 && !opts.some(o => o.querySelector(".ot div").textContent === "Default") && tx(opts[0].querySelector(".od")).includes("(app default)")
    && opts.some(o => o.querySelector(".ot div").textContent === "w@example.com") && opts.some(o => o.querySelector(".ot div").textContent === "Work login"));
  ev(`state.accounts = state.accounts.filter(a => a.id !== "fake-x")`);
  opts.find(o => o.querySelector(".ot div").textContent === "Work login").click();
  ok("choosing an account shows it in the editor", tx("#pf-account") === "Work login" && !/app default/.test(tx("#pf-account")));
  $("#pf-save").click();
  await until(() => ev(`state.profiles.find(p => p.id === "work").accounts.local`) === added.account.id, 10000, "account saved");
  ok("the server has the chosen account for the profile", (await ev('conn.call("profiles.list")')).profiles.find(p => p.id === "work").accounts.local === added.account.id);

  // ───── errors show next to their field ─────
  $$("#page-body .prof-row").find(r => r.textContent.includes("Work")).click();
  await until(() => $("#pf-env"));
  $("#pf-env").value = "JUSTAWORD";
  $("#pf-save").click();
  ok("an env mistake shows under the env field", !$('#page-body .pf-err[data-for="env"]').hidden && /KEY=value/.test(tx('#page-body .pf-err[data-for="env"]')) && !$("#pf-save").disabled);
  $("#pf-env").value = "SITE=work";
  setPick(A);   // already in Personal: the server refuses it
  $("#pf-add").click();
  await until(() => $$("#page-body .pf-folder").length === 2);
  $("#pf-save").click();
  await until(() => !$('#page-body .pf-err[data-for="folders"]').hidden, 10000, "folder error");
  ok(`a folder already in another profile shows under Folders: "${tx('#page-body .pf-err[data-for="folders"]')}"`,
    /already in Personal/.test(tx('#page-body .pf-err[data-for="folders"]')) && !$("#pf-save").disabled);
  $$("#page-body .pf-folder").find(r => tx(r.querySelector(".l")) === ev(`shortPath(${JSON.stringify(A)})`)).querySelector(".pf-x").click();
  ok("a folder's × removes it from the draft", $$("#page-body .pf-folder").length === 1);

  // ───── Make default, then Delete (hidden when it is the only one) ─────
  ok("a profile that is not the default can be made it", !!$("#pf-default"));
  $("#pf-default").click();
  await until(() => ev("state.defaultProfile") === "work", 10000, "make default");
  ok("making it default updates the app at once", ev("state.defaultProfile") === "work" && !$("#pf-default"));
  ev("page.back()");
  await until(() => $$("#page-body .prof-row").length === 2);
  $$("#page-body .prof-row").find(r => r.textContent.includes("Personal")).click();
  await until(() => $("#pf-delete"));
  $("#pf-delete").click();
  ok("Delete asks first, in the app's confirm sheet", ev("sheet.isOpen") && /Delete Personal\?/.test(tx("#sheet")));
  $('#sheet [data-r="1"]').click();
  await until(() => ev("state.profiles.length") === 1, 10000, "delete");
  ok("deleting leaves the other profile, now the default", $("#page-title").textContent === "Profiles" && $$("#page-body .prof-row").length === 1 && tx("#page-body .prof-row").includes("Work") && ev("state.defaultProfile") === "work");
  ev("page.close()");

  // ───── the drawer: two profiles, filter, dots, a worker follows its parent ─────
  ev(`window.__two = [
    { id: "personal", name: "Personal", color: "teal", workspaces: [${JSON.stringify(B)}], accounts: {}, env: {} },
    { id: "work", name: "Work", color: "blue", workspaces: [${JSON.stringify(Asub)}], accounts: {}, env: {} } ];
    state.profiles = window.__two;
    state.defaultProfile = "personal";
    state.profileFilter = "";
    state.sessions = [
      { sessionId: "s-work", title: "Work chat", cwd: ${JSON.stringify(Asub + "/deep")}, lastModified: Date.now(), profile: "work" },
      { sessionId: "s-personal", title: "Personal chat", cwd: ${JSON.stringify(B)}, lastModified: Date.now(), profile: "personal" },
      { sessionId: "s-worker", title: "Worker chat", cwd: ${JSON.stringify(B)}, lastModified: Date.now(), profile: "personal", parent: "s-work" } ];
    state.openKids.add("s-work"); renderProfileFilter(); renderSessions()`);
  ok(`two profiles: All · Personal · Work, and a dot in each chat's colour`,
    !$("#profile-filters").hidden && $$("#profile-filters button").map(b => b.textContent).join(",") === "All,Personal,Work"
    && $$("#session-list .sess").length === 3 && $$("#session-list .sess .pdot.pc-blue").length === 2 && $$("#session-list .sess .pdot.pc-teal").length === 1);
  const workerRow = $$("#session-list .sess").find(r => tx(r).includes("Worker chat"));
  ok("a worker follows its parent: its own folder is Personal, its dot is Work's", workerRow?.classList.contains("kid") && !!workerRow?.querySelector(".pdot.pc-blue"));
  $$("#profile-filters button").find(b => b.textContent === "Work").click();
  ok(`choosing Work hides the Personal chat: ${$$("#session-list .sess").map(r => tx(r.querySelector(".t div"))).join(" / ")}`,
    $$("#session-list .sess").length === 2 && !tx("#session-list").includes("Personal chat") && tx("#session-list").includes("Worker chat") && ev('localStorage.getItem("pa.profileFilter")') === "work");
  $$("#profile-filters button").find(b => b.textContent === "Personal").click();
  ok("choosing Personal hides Work and its worker", $$("#session-list .sess").length === 1 && tx("#session-list").includes("Personal chat") && !tx("#session-list").includes("Worker chat"));
  $$("#profile-filters button")[0].click();
  ok("All brings every chat back, and forgets the filter", $$("#session-list .sess").length === 3 && ev('localStorage.getItem("pa.profileFilter")') === null);

  // ───── the header and a new chat's folder chip ─────
  ev(`state.profiles = []; state.defaultProfile = "personal"; showEmpty(); profilesHello({ profiles: window.__two, defaultProfile: "personal" })`);
  ok("profiles that arrive after the empty state is drawn add its chip", /Personal/.test(tx("#empty-cwd")) && !!$("#empty-cwd .pchip"));
  ev(`newChat(${JSON.stringify(Asub + "/deep")})`);
  ok(`the chat header includes the profile: "${tx("#chat-sub")}"`, /· Work/.test(tx("#chat-sub")));
  ok(`a new chat's folder says its profile: "${tx("#empty-cwd")}"`, /Work/.test(tx("#empty-cwd")) && !!$("#empty-cwd .pchip .pdot.pc-blue"));
  ev(`newChat(${JSON.stringify(B)})`);
  ok("moving to a folder in another profile changes both", /· Personal/.test(tx("#chat-sub")) && /Personal/.test(tx("#empty-cwd")));

  // ───── the longest workspace wins, the + "/" rule holds ─────
  ok("profileOfCwd takes the longest workspace, and matches whole folders only",
    ev(`profileOfCwd(${JSON.stringify(Asub + "/deep")}).id === "work" && profileOfCwd(${JSON.stringify(Asub)}).id === "work"
      && profileOfCwd(${JSON.stringify(A)}).id === "personal" && profileOfCwd(${JSON.stringify(B)}).id === "personal"
      && profileOfCwd(${JSON.stringify(Asub + "x")}).id === "personal"`));

  ok("no page errors", errors.length === 0 || console.log(errors.join("\n")) || false);
  w.close();
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
} finally {
  await new Promise(r => { const t = setTimeout(r, 3000); server.once("exit", () => { clearTimeout(t); r(); }); server.kill(); });
  fs.rmSync(T, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
