// Screen test for environments (#69): Settings → Environments (the row, the page, the state dots, the sheet with
// rename / test / reconnect / pair again / remove), adding one with a pairing code, the drawer's Phone / device
// filter and its dimmed chats, the offline notice and the new-chat "Where" row (its folder picker browses that
// machine). It loads the real UI in jsdom and starts a throwaway server of its own (a temp home and data, never the
// app's), so `npm run test:environments` needs nothing else. The environments.* requests and the other machine's
// fs.list are answered here, so it needs no second Pocket Agent server either.
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import crypto from "node:crypto"; import net from "node:net";
import { spawn } from "node:child_process";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, what = "condition") { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(50); } throw new Error("timeout: " + what); }
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
const health = async port => { try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } };

// Its own server: a throwaway home and data, so the app's chats and settings are never touched.
const PORT = await freePort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pa-env-ui-"));
const secret = crypto.randomBytes(24).toString("hex");
let child = null;
function cleanup() {
  if (child && child.exitCode === null) { try { child.kill("SIGTERM"); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);
{
  const fake = path.join(tmp, "fake-claude");
  fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const env = { ...process.env, HOME: tmp, PA_DATA: path.join(tmp, ".pocket-agent"), PA_CLAUDE: fake };
  delete env.CLAUDE_CONFIG_DIR; delete env.PA_SUPERVISED; delete env.PA_MODE; delete env.PA_PORT; delete env.PA_HUB_BACKOFF_MS;
  child = spawn("node", [path.join(REPO, "server/src/index.js"), "--port", String(PORT), "--token", secret], { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const end = Date.now() + 20000; Date.now() < end && !(await health(PORT));) await sleep(150);
  if (!(await health(PORT))) { console.error("FAIL the test server didn't start"); process.exit(1); }
}

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push("jsdomError: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ").slice(0, 300)));

const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/ui/#token=${secret}`, {
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
let fails = 0;
const ok = (name, c) => { console.log(c ? "PASS" : "FAIL", name); if (!c) fails++; };
const text = s => ($(s)?.textContent || "").replace(/\s+/g, " ").trim();
const menu = label => $$("#sheet .menu-item").find(x => new RegExp(label).test(x.textContent));

await new Promise(r => w.addEventListener("load", r));
await until(() => ev("conn.ok") && ev("state.home"), 20000, "connect + hello");
await sleep(200);

// The fake side: the environments.* requests, the other machine's files, and events as the server would send them.
ev(`
  window.__envs = [];
  window.__calls = [];
  window.__realCall = conn.call.bind(conn);
  window.__fakeEnvs = () => JSON.parse(JSON.stringify(__envs));
  window.__fire = () => conn.fire("environments", { environments: __fakeEnvs() });
  conn.call = (t, m = {}) => {
    __calls.push([t, m]);
    if (t === "environments.list") return Promise.resolve({ environments: __fakeEnvs() });
    if (t === "environments.test") {
      if (/bad/.test(m.url || "")) return Promise.reject(new Error("Can't reach bad:8765"));
      return Promise.resolve({ ok: true, version: "1.3.0", protocol: 1, ms: 84 });
    }
    if (t === "environments.add") {
      if (m.code === "WRONG" || m.code === "WRONG-CODE") return Promise.reject(new Error("That code is wrong or has expired"));
      let e = __envs.find(x => x.url === m.url);
      if (!e) { e = { id: "env-new", name: "Laptop", url: m.url, profile: m.profile || "personal", state: "connecting", version: null, protocol: null, error: null, lastOnlineAt: null }; __envs = [...__envs, e]; }
      else Object.assign(e, { state: "connecting", error: null });
      __fire();
      return Promise.resolve({ environment: JSON.parse(JSON.stringify(e)) });
    }
    if (t === "environments.rename") {
      const e = __envs.find(x => x.id === m.environment);
      if (!e) return Promise.reject(new Error("No such environment"));
      e.name = m.name; __fire(); return Promise.resolve({ environment: JSON.parse(JSON.stringify(e)) });
    }
    if (t === "environments.reconnect") {
      const e = __envs.find(x => x.id === m.environment); e.state = "connecting"; e.error = null;
      __fire(); return Promise.resolve({ environment: JSON.parse(JSON.stringify(e)) });
    }
    if (t === "environments.remove") {
      __envs = __envs.filter(x => x.id !== m.environment); __fire(); return Promise.resolve({ ok: true });
    }
    if (t === "fs.list" && m.env) {
      return Promise.resolve({ path: m.path || "/home/me", parent: "/", entries: [
        { name: "projects", dir: true, size: 0 }, { name: "notes.md", dir: false, size: 120 }] });
    }
    return __realCall(t, m);
  };
`);

const reset = () => ev(`sheet.close(true); page.close()`);
const envA = { id: "env-a", name: "MacBook Pro", url: "http://100.64.0.1:8765", profile: "personal", state: "online", version: "1.3.0", protocol: 1, error: null, lastOnlineAt: Date.now() };
const envB = { id: "env-b", name: "Work PC", url: "http://100.64.0.2:8765", profile: "personal", state: "offline", version: null, protocol: null, error: "Can't reach 100.64.0.2:8765", lastOnlineAt: null };
const fire = list => ev(`__envs = ${JSON.stringify(list)}; __fire()`);

// 1. Settings: one Environments row, saying None with no environments
ev("openSettings()");
const cat = $('[data-sec="environments"]');
ok("Settings has an Environments row, saying None", !!cat && cat.textContent.includes("Environments") && cat.querySelector("small").textContent === "None");
reset();

// 2. The event's render: both devices on the page, each with its state dot and its line
fire([envA, envB]);
ev("openSettings()");
ok(`the row counts them: "${$('[data-sec="environments"] small').textContent}"`, $('[data-sec="environments"] small').textContent === "2 · 1 online");
ev(`document.querySelector('[data-sec="environments"]').click()`);
let rows = $$("#page-body .env-row");
ok("the page lists each environment", rows.length === 2 && rows[0].textContent.includes("MacBook Pro") && rows[1].textContent.includes("Work PC"));
ok("the dots say online and offline", !!rows[0].querySelector(".dot.online") && !!rows[1].querySelector(".dot.offline"));
ok(`each row says the state, version and address: "${rows[0].querySelector("small").textContent}"`,
  rows[0].querySelector("small").textContent === "Online · v1.3.0 · 100.64.0.1:8765"
  && rows[1].querySelector("small").textContent === "Can't reach 100.64.0.2:8765 · 100.64.0.2:8765");
ok("Add environment is a text button at the bottom", !!$("#page-body #env-add"));

// 3. One environment's sheet: rename, test, reconnect, pair again, remove
rows[0].click();
ok("tapping one opens its sheet", ev("sheet.isOpen") && text("#sheet h2") === "MacBook Pro"
  && ["Rename", "Test connection", "Reconnect", "Pair again", "Remove"].every(l => text("#sheet").includes(l)));
menu("Test connection").click();
await until(() => /OK · 84 ms · v1\.3\.0/.test(text("#env-test-res")), 5000, "test result");
ok("Test connection answers inline", text("#env-test-res") === "OK · 84 ms · v1.3.0");
menu("Rename").click();
await until(() => $("#ps-in"), 3000, "rename prompt");
$("#ps-in").value = "Mac";
$('#sheet [data-r="1"]').click();
await until(() => ev("state.environments[0].name") === "Mac", 5000, "renamed");
ok("Rename updates the list", /Mac/.test($("#page-body .env-row").textContent) && ev(`__envs[0].name`) === "Mac");
$("#page-body .env-row").click();
menu("Reconnect").click();
await until(() => $("#page-body .env-row .dot.connecting"), 5000, "connecting dot");
ok("Reconnect shows it connecting, pulsing", !!$("#page-body .env-row .dot.connecting"));
$("#page-body .env-row").click();
menu("Pair again").click();
await until(() => $("#ps-in"), 3000, "pair prompt");
$("#ps-in").value = "abcd-efgh";
$('#sheet [data-r="1"]').click();
await until(() => ev(`__calls.some(([t, m]) => t === "environments.add" && m.code === "ABCD-EFGH" && m.name === "Mac")`), 5000, "pair again");
ok("Pair again asks for a new code and pairs under the same name", ev(`__calls.some(([t, m]) => t === "environments.add" && m.code === "ABCD-EFGH" && m.name === "Mac")`));
// Remove asks first
$("#page-body .env-row").click();
menu("Remove").click();
await until(() => $("#sheet h2") && /Remove Mac\?/.test(text("#sheet h2")), 3000, "remove confirm");
ok("Remove asks before removing", /Remove Mac\?/.test(text("#sheet h2")));
$('#sheet [data-r="1"]').click();
await until(() => !ev("state.environments.some(e => e.name === 'Mac')"), 5000, "removed");
ok("removing takes it off the page and the list", ev("state.environments.length") === 1 && !$("#page-body").textContent.includes("Mac"));

// 4. Add: address, a code uppercased as typed, Test, Add, errors under the title
fire([envA]);
ev("openSettings()"); ev(`document.querySelector('[data-sec="environments"]').click()`);
$("#page-body #env-add").click();
ok("Add environment opens its sheet", ev("sheet.isOpen") && text("#sheet h2") === "Add environment" && $("#env-code").placeholder === "ABCD-EFGH" && $("#env-url").placeholder === "100.101.102.103:8765");
ok("the code line says where to get one", /Get a code on the other computer: node server\/src\/pair-cli\.js/.test(text("#sheet")));
ok("no Profile select with fewer than two profiles", !$("#env-profile"));
ev(`const i = document.querySelector("#env-code"); i.value = "abcd-efgh"; i.dispatchEvent(new window.Event("input"))`);
ok("the pair code uppercases as it's typed", ev(`document.querySelector("#env-code").value`) === "ABCD-EFGH");
ev(`const u = document.querySelector("#env-url"); u.value = "bad:8765"; document.querySelector("#env-test").click()`);
await until(() => /Can't reach bad:8765/.test(text("#env-test-res")), 5000, "test error");
ok("Test answers inline, an error in red", $("#env-test-res").classList.contains("err") && text("#env-test-res") === "Can't reach bad:8765");
ev(`const u = document.querySelector("#env-url"); u.value = "100.101.102.103:8765"; document.querySelector("#env-test").click()`);
await until(() => /OK · 84 ms/.test(text("#env-test-res")), 5000, "test ok");
ok("…and a good address answers OK with its version", text("#env-test-res") === "OK · 84 ms · v1.3.0");
ev(`window.__profSave = { profiles: state.profiles, defaultProfile: state.defaultProfile };
  state.profiles = ["personal", "work"]; state.defaultProfile = "work"; sheet.close(true); addEnvironmentSheet()`);
ok("two profiles add a Profile select, defaulting to the default profile", $$("#env-profile option").length === 2 && $("#env-profile").value === "work");
ev(`document.querySelector("#env-profile").value = "work";
  const u = document.querySelector("#env-url"); u.value = "100.64.0.9:8765";
  const c = document.querySelector("#env-code"); c.value = "WRONG"; c.dispatchEvent(new window.Event("input"));
  document.querySelector("#env-add-btn").click()`);
await until(() => !$("#env-err").hidden, 5000, "add error");
ok("a wrong code shows inline under the sheet title", !$("#env-err").hidden && text("#env-err") === "That code is wrong or has expired" && ev("sheet.isOpen") && $("#env-err").previousElementSibling === $("#sheet h2"));
ev(`const c = document.querySelector("#env-code"); c.value = "xyz-1234"; c.dispatchEvent(new window.Event("input")); document.querySelector("#env-add-btn").click()`);
await until(() => !ev("sheet.isOpen"), 5000, "sheet closed after adding");
await until(() => ev("state.environments.some(e => e.id === 'env-new')"), 5000, "the new environment");
ok("adding closes the sheet and shows the new one connecting, with the profile chosen",
  ev(`__calls.some(([t, m]) => t === "environments.add" && m.profile === "work" && m.code === "XYZ-1234")`)
  && !!$("#page-body .env-row .dot.connecting"));
fire([envA, { ...envA, id: "env-new", name: "Laptop", url: "http://100.64.0.9:8765", state: "online" }]);
ok("when it connects the dot turns green", !!$$("#page-body .env-row").some(r => /Laptop/.test(r.textContent) && r.querySelector(".dot.online")));

// 5. The drawer: a device's chats dimmed with its chip, and the All / Phone / device filter
ev(`state.profiles = []; if (window.__profSave) { state.defaultProfile = window.__profSave.defaultProfile; delete window.__profSave; }`);
const envC = { id: "env-c", name: "A very long machine name", url: "http://100.64.0.3:8765", profile: "personal", state: "offline", version: null, protocol: null, error: "Can't reach 100.64.0.3:8765", lastOnlineAt: null };
fire([envA, envB, envC]);
const local = { sessionId: "cccccccc-0000-4000-8000-0000000000b1", title: "Local chat", cwd: "/home/me/app", lastModified: Date.now() };
const remoteA = { sessionId: "env-a:aaaaaaaa-0000-4000-8000-0000000000b2", title: "On the Mac", cwd: "/Users/me/code", lastModified: Date.now() - 1000, remote: true, environment: "env-a", environmentName: "MacBook Pro", offline: false };
const remoteB = { sessionId: "env-b:bbbbbbbb-0000-4000-8000-0000000000b3", title: "On the PC", cwd: "/home/work", lastModified: Date.now() - 2000, remote: true, environment: "env-b", environmentName: "Work PC", offline: true };
const remoteC = { sessionId: "env-c:dddddddd-0000-4000-8000-0000000000b4", title: "On the long one", cwd: "/home/long", lastModified: Date.now() - 3000, remote: true, environment: "env-c", environmentName: "A very long machine name", offline: true };
ev(`state.sessions = ${JSON.stringify([local, remoteA, remoteB, remoteC])}; state.envFilter = ""; renderEnvFilters(); renderSessions()`);
ok("the drawer gets All · Phone · each device, a long name ending in an ellipsis at 12 characters", !$("#env-filters").hidden && $$("#env-filters button").map(b => b.textContent).join(" | ") === "All | Phone | MacBook Pro | Work PC | A very long…");
const offRow = $$("#session-list .sess").find(b => /On the long one/.test(b.textContent));
ok("an offline device's chat is dimmed, says offline and shows its chip",
  offRow.classList.contains("offline") && /offline/.test(offRow.querySelector(".meta").textContent)
  && offRow.querySelector(".meta .meta-env") && /A very long…/.test(offRow.querySelector(".meta .meta-env").textContent));
ok("the chip is 12 characters at most", offRow.querySelector(".meta-env").textContent.length <= 12 && offRow.querySelector(".meta-env").textContent.endsWith("…"));
$$("#env-filters button").find(b => b.textContent === "MacBook Pro").click();
ok("picking a device filters the chats to it, and is remembered",
  ev("state.envFilter") === "env-a" && $$("#session-list .sess").length === 1 && /On the Mac/.test($("#session-list").textContent)
  && ev(`localStorage.getItem("pa.envFilter")`) === "env-a");
$$("#env-filters button").find(b => b.textContent === "Phone").click();
ok("Phone shows only this phone's chats", $$("#session-list .sess").length === 1 && /Local chat/.test($("#session-list").textContent));
$$("#env-filters button").find(b => b.textContent === "All").click();
ok("All shows everyone's", $$("#session-list .sess").length === 4 && ev(`localStorage.getItem("pa.envFilter")`) === "");

// 6. A chat on an offline device: its name in the header, the notice, no sending
ev(`state.current = { sessionId: ${JSON.stringify(remoteC.sessionId)}, cwd: "/home/long", title: "On the long one", isNew: false, lastSeq: 0 }; updateHeader(); updateComposer()`);
ok(`the header names the device: "${text("#chat-sub")}"`, text("#chat-sub").startsWith("A very long machine name · "));
ok("a one-line notice says it's offline", !$("#env-offline").hidden && text("#env-offline") === "A very long machine name is offline. The chat comes back when it's on.");
ok("sending is off while it's away", $("#btn-send").disabled && ev("input.placeholder") === "A very long machine name is offline");
ev(`input.value = "hello"; window.__calls = []; send()`);
await sleep(150);
ok("send does nothing but say so", !ev(`__calls.some(([t]) => t === "send")`) && /is offline/.test(w.document.querySelector("#toast").textContent));
fire([envA, { ...envB, state: "online", error: null }, { ...envC, state: "online", error: null }]);
ok("when it comes back the notice goes and sending works again", $("#env-offline").hidden && !$("#btn-send").disabled);

// 7. New chat: the Where row, its id and its folder picker on that machine
fire([envA, { ...envB, state: "offline", error: "Can't reach 100.64.0.2:8765" }]);
ev("newChat()");
ok("an online device adds a Where row: Phone, then each device", !$("#new-where").hidden
  && $$("#new-where button").map(b => b.textContent).join(" | ") === "Phone | MacBook Pro | Work PC"
  && $$("#new-where button.on").map(b => b.textContent).join("") === "Phone");
ok("only the online ones can be picked", $$("#new-where button").filter(b => b.disabled).map(b => b.textContent).join("") === "Work PC");
$$("#new-where button").find(b => b.textContent === "MacBook Pro").click();
await until(() => ev("state.current.cwd") === "/home/me", 5000, "the other machine's home");
ok("choosing a device gives the chat its id and starts in its home", ev("state.current.sessionId").startsWith("env-a:") && ev("state.current.cwd") === "/home/me"
  && ev(`__calls.some(([t, m]) => t === "fs.list" && m.env === "env-a" && !m.path)`));
ok("the header names it, and there is no offline notice", text("#chat-sub").startsWith("MacBook Pro · ") && $("#env-offline").hidden);
$$("#new-where button").find(b => b.textContent === "Phone").click();
ok("back on Phone the id has no prefix", !ev("state.current.sessionId.includes(':')"));
ev("newChat('/tmp/x')");
ok("a local new chat is as before", !ev("state.current.sessionId.includes(':')") && ev("state.current.cwd") === "/tmp/x");
ev("newChat(undefined, undefined, 'env-a')");
ok("a new chat made for a device gets its prefix", ev("state.current.sessionId.startsWith('env-a:')"));
// the folder picker browses that machine, with env on every files call
ev(`window.__picked = null; pickFolder("", "env-a").then(x => window.__picked = x)`);
await sleep(100);
$('#sheet [data-a="browse"]').click();
await until(() => $$("#page-body .list-row").length > 0, 5000, "remote browse");
ok("Browse on a device asks that machine for its files, with env", ev(`__calls.some(([t, m]) => t === "fs.list" && m.env === "env-a" && !m.path)`));
ok("it lists the other machine's folders", $$("#page-body .list-row").some(r => /projects/.test(r.textContent)));
$$("#page-body .list-row").find(r => /projects/.test(r.textContent)).click();
await until(() => ev(`__calls.some(([t, m]) => t === "fs.list" && m.env === "env-a" && m.path === "/home/me/projects")`), 5000, "into the folder");
ok("going into a folder keeps env", ev(`__calls.some(([t, m]) => t === "fs.list" && m.env === "env-a" && m.path === "/home/me/projects")`));
$$("#page-body button").find(b => /Use this folder/.test(b.textContent))?.click();
await until(() => ev("window.__picked") === "/home/me/projects", 5000, "folder chosen");
ok("it hands the folder back", ev("window.__picked") === "/home/me/projects");
// no online device: no Where row at all
fire([{ ...envB, state: "offline" }]);
ev("newChat()");
ok("with no device online there is no Where row", $("#new-where").hidden);
fire([]);
ev("newChat()");

reset();
console.log(errors.length ? "\nPAGE ERRORS:\n" + errors.join("\n") : "\nno page errors");
if (errors.length) fails++;
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
w.close();
cleanup();
process.exit(fails ? 1 : 0);
