// Drives the first-run setup screen (app/assets/ui/setup.html) with a fake native bridge:
// intro → install progress → sign-in (open link, paste code) → start server → hand over to the app.
// Also checks the "connect to a server instead" path. No device or network needed.
import { JSDOM, VirtualConsole } from "jsdom";
import path from "node:path";

const file = path.resolve(new URL(".", import.meta.url).pathname, "../../app/assets/ui/setup.html");
let fails = 0;
const ok = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(30); } return false; }

async function boot({ installed = false, loggedIn = false, hash = "" } = {}) {
  const calls = [], errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/navigation/i.test(e.message)) errors.push(e.message); });
  const st = { installed, loggedIn, navigated: null, settings: {} };
  const dom = await JSDOM.fromFile(file, {
    runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc, url: "file://" + file + hash,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.fetch = async url => ({ ok: /health/.test(url) });
      const reply = (id, result, error) => setTimeout(() => w.paNative.emit("rpc", JSON.stringify(error ? { id, error } : { id, result })), 5);
      w.PA = {
        setTheme() {}, ready() {}, uiSettings: () => JSON.stringify(st.settings), settingsChanged: j => { st.settings = JSON.parse(j); },
        rpc(id, method, params) {
          calls.push({ method, params: JSON.parse(params) });
          switch (method) {
            case "runtime.status": return reply(id, { installed: st.installed, freeMB: 8000, serverUrl: "http://127.0.0.1:8790", progress: {} });
            case "runtime.install":
              reply(id, true);
              // simulate Linux.java progress events
              [["rootfs", 5, "1 / 4 MB"], ["packages", 30, "Installing nodejs"], ["claude", 60, "Downloading"], ["server", 90, "npm install"], ["done", 100, ""]]
                .forEach(([step, pct, detail], i) => setTimeout(() => { if (step === "done") st.installed = true; w.paNative.emit("runtime", JSON.stringify({ step, pct, detail, label: step })); }, 40 * (i + 1)));
              return;
            case "runtime.auth": return reply(id, { loggedIn: st.loggedIn });
            case "runtime.login.start": return reply(id, { url: "https://claude.com/cai/oauth/authorize?code=true&client_id=x" });
            case "clipboard.set": return reply(id, true);
            case "url.open": return reply(id, true);
            case "runtime.login.code": st.loggedIn = true; return reply(id, { loggedIn: true, email: "me@example.com" });
            case "runtime.start": case "runtime.restart": return reply(id, true);
            case "runtime.logs": return reply(id, "log line");
            case "mode.set": return reply(id, true);
            default: return reply(id, null, "unknown " + method);
          }
        },
      };
    },
  });
  const w = dom.window;
  // capture the hand-over navigation (jsdom doesn't navigate)
  await new Promise(r => w.addEventListener("load", r));
  return { w, $: s => w.document.querySelector(s), calls, errors, st };
}
const visible = (t, id) => !t.$(id).hidden;

// 1. full first run
{
  const t = await boot();
  await until(() => visible(t, "#s-intro"));
  ok("first run shows the intro", visible(t, "#s-intro"));
  ok("shows free space", /GB|MB/.test(t.$("#free").textContent));
  t.$("#start").click();
  await until(() => visible(t, "#s-progress"));
  ok("starting shows progress", visible(t, "#s-progress") && t.calls.some(c => c.method === "runtime.install"));
  await until(() => visible(t, "#s-login"), 3000);
  ok("after install, not signed in → sign-in step", visible(t, "#s-login"));
  ok("finish is disabled until a link was opened and a code pasted", t.$("#finish-login").disabled);
  t.$("#open-login").click();
  await until(() => t.calls.some(c => c.method === "url.open"));
  ok("open sign-in page opens the OAuth URL", t.calls.find(c => c.method === "url.open")?.params.url.includes("oauth/authorize"));
  t.$("#code").value = "abc#123"; t.$("#code").dispatchEvent(new t.w.Event("input"));
  ok("pasting a code enables finish", !t.$("#finish-login").disabled);
  t.$("#finish-login").click();
  await until(() => /Signed in/.test(t.$("#l-msg").textContent));
  ok("sign-in success message shows the account", /me@example\.com/.test(t.$("#l-msg").textContent));
  ok("code was sent to Claude", t.calls.find(c => c.method === "runtime.login.code")?.params.code === "abc#123");
  await until(() => t.calls.some(c => c.method === "runtime.start"), 3000);
  ok("then starts the built-in server", t.calls.some(c => c.method === "runtime.start"));
  ok("no page errors", t.errors.length === 0 || console.log(t.errors) || false);
  t.w.close();
}

// 2. already installed and signed in → straight to starting the app
{
  const t = await boot({ installed: true, loggedIn: true });
  await until(() => t.calls.some(c => c.method === "runtime.start"), 3000);
  ok("installed + signed in: skips setup and starts the server", t.calls.some(c => c.method === "runtime.start") && !t.calls.some(c => c.method === "runtime.install"));
  t.w.close();
}

// 3. connect to a server instead
{
  const t = await boot();
  await until(() => visible(t, "#s-intro"));
  t.$("#use-server").click();
  ok("server option shows the form", visible(t, "#s-server"));
  t.$("#srv-token").value = "tok123";
  t.$("#srv-connect").click();
  await until(() => t.calls.some(c => c.method === "mode.set"));
  const m = t.calls.find(c => c.method === "mode.set");
  ok("switches the app to that server", m?.params.server === "http://127.0.0.1:8765" && m.params.token === "tok123");
  ok("server choice is saved in the app's settings", t.st.settings.server === "http://127.0.0.1:8765");
  t.w.close();
}

// 4. sign in again (from Settings) and trouble screen
{
  const t = await boot({ installed: true, loggedIn: true, hash: "#login" });
  await until(() => visible(t, "#s-login"));
  ok("#login opens the sign-in step directly", visible(t, "#s-login"));
  t.w.close();
  const u = await boot({ installed: true, loggedIn: true, hash: "#trouble" });
  await until(() => /Couldn't start/.test(u.$("#st-title").textContent));
  ok("#trouble shows the server log and a restart button", !u.$("#st-restart").hidden && !u.$("#st-logbox").hidden);
  u.w.close();
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
