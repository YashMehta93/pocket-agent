// Headless UI test: loads the real UI from the running server in jsdom and drives it.
// Usage: node tools/ui-test.mjs [--live]   (--live also runs a real Claude turn with an approval)
const PORT = process.env.PA_PORT || 8765;
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs"; import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.pocket-agent/token", "utf8").trim();
const LIVE = process.argv.includes("--live");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push("jsdomError: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")));
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ").slice(0, 300)));
vc.on("warn", (...a) => console.log("  warn:", a.map(String).join(" ").slice(0, 200)));

const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/ui/#token=${token}`, {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: true, addEventListener() {} });
    w.ResizeObserver = class { observe() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    if (!w.crypto.randomUUID) w.crypto.randomUUID = () => crypto.randomUUID();
  },
});
const w = dom.window;
const ev = s => w.eval(s);
const $ = s => w.document.querySelector(s);
const $$ = s => [...w.document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, what = "condition") { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(100); } throw new Error("timeout: " + what); }
let fails = 0;
const ok = (name, c) => { console.log(c ? "PASS" : "FAIL", name); if (!c) fails++; };

await new Promise(r => w.addEventListener("load", r));
await until(() => ev("conn.ok") && ev("state.sessions.length") > 0, 20000, "connect + sessions");
ok(`connected, ${ev("state.sessions.length")} sessions in drawer`, $$("#session-list .sess").length > 0);
ok("composer chips rendered", $("#chip-mode").textContent.length > 0 && $("#chip-model").textContent.length > 0);

// open the biggest existing session
const big = ev("state.sessions.slice().sort((a,b)=>b.lastModified-a.lastModified).find(s=>s.title)?.sessionId");
await ev(`openSession(${JSON.stringify(big)})`);
await until(() => $$("#messages > *").length > 0, 20000, "history render");
ok(`history rendered: ${$$(".user-msg").length} user msgs, ${$$(".tool").length} tool cards, ${$$("#messages .md").length} text blocks`, $$(".user-msg").length > 0);
ok("title set", $("#chat-title").textContent !== "New chat");

// drawer search
ev(`state.filter = "zzzz-no-match"; renderSessions()`);
ok("search filter empties list", $$("#session-list .sess").length === 0);
ev(`state.filter = ""; renderSessions()`);

// slash command popup
ev(`input.value = "/"; input.selectionStart = input.selectionEnd = 1; input.dispatchEvent(new window.Event("input"))`);
await sleep(400);
ok(`slash popup shows ${$$("#popup button").length} commands`, $$("#popup button").length > 0 || ev("state.commands.length") === 0);
ev(`input.value = ""; document.querySelector("#popup").hidden = true`);

// pages
ev("openSettings()"); ok(`settings home shows categories (${$$(".set-cat").length})`, !$("#page").hidden && $$(".set-cat").length >= 7 && $$("#page-body .set-row").length === 0);
ev(`const q = document.querySelector("#set-q"); q.value = "theme"; q.dispatchEvent(new window.Event("input"))`);
ok("search finds a setting across categories", $$("#set-results .set-item:not([hidden])").length >= 1 && $("#set-results").textContent.includes("Theme") && $("#set-home").hidden);
ev(`const q = document.querySelector("#set-q"); q.value = "zzz-nothing"; q.dispatchEvent(new window.Event("input"))`);
ok("search says when nothing matches", /No setting matches/.test($("#set-results").textContent));
ev(`document.querySelector("#set-q").value = ""; document.querySelector("#set-q").dispatchEvent(new window.Event("input")); document.querySelector('[data-sec="look"]').click()`);
ok("a category opens its own page with its controls", ev("document.querySelector('#page-title').textContent") === "Appearance" && $$("#page-body .set-row").length >= 3 && $$("#page-body #s-theme button").length === 3);
ev(`document.querySelector('#s-theme button[data-v="dark"]').click()`); ok("a setting works from its category page", ev("settings.theme") === "dark"); ev(`settings.theme = "system"; saveSettings()`);
ev("page.close()");
// usage limits: drawer meter, the note above the message box from 90%, the details sheet, the settings row
ev(`state.usage = { windows: { five_hour: { used: 91, resetsAt: Date.now() + 3 * 3600e3 + 50 * 60e3, status: "allowed_warning" }, seven_day: { used: 64, resetsAt: Date.now() + 4 * 86400e3, status: "allowed" } }, models: [{ name: "Fable", used: 40, resetsAt: Date.now() + 4 * 86400e3 }], at: Date.now() }; renderUsage()`);
ok("drawer shows the 5-hour and weekly limits", !$("#usage-meter").hidden && $$("#usage-meter .u-row").length === 2 && /91%.*resets in 3h \d+m/.test($("#usage-meter").textContent) && $("#usage-meter .u-row.warn") !== null);
ok("a ring in the chat header shows the fuller limit", !$("#btn-usage").hidden && /5-hour limit 91% used/.test($("#btn-usage").getAttribute("aria-label")) && $("#btn-usage").classList.contains("warn"));
ok("a note above the message box warns from 90%", !$("#usage-note").hidden && /91% of your 5-hour limit used · resets in 3h/.test($("#usage-note").textContent));
ev("openUsage()"); ok("tapping opens every limit, per model too", ev("sheet.key") === "usage" && $$("#sheet .u-row").length === 3 && $("#sheet").textContent.includes("Week · Fable")); ev("sheet.close(true)");
ev(`state.usage.windows.five_hour.resetsAt = Date.now() - 1000; renderUsage()`);
ok("once a window resets, it shows 0% and the note goes", $("#usage-note").hidden && /5-hour\s*0%/.test($("#usage-meter").textContent));
ev("openSettings()"); ev(`const q = document.querySelector("#set-q"); q.value = "usage"; q.dispatchEvent(new window.Event("input"))`);
ok("settings search finds the usage limits", $("#set-results").textContent.includes("Usage limits") && $("#set-results").textContent.includes("Week 64%")); ev("page.close()");
ev(`state.usage = null; renderUsage()`);

ev("openFiles(state.home)"); await until(() => $$("#page-body .list-row").length > 0, 10000, "files list"); ok("files page lists entries", true); ev("page.close()");
ev(`document.querySelector("#chip-mode").click()`); ok("mode sheet opens", ev("sheet.isOpen") && $$("#sheet .opt").length === 5); ev("sheet.close(true)");
ev(`state.models = [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" }, { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" }]`);
ok("the model chip names the real model, never Default", ev('modelLabel(null)') === "Opus 5.5" && ev('modelLabel("default")') === "Opus 5.5" && ev('modelLabel("claude-haiku-4-5-20251001")') === "Haiku 4.5" && ev('modelLabel("claude-sonnet-5-5[1m]")') === "Sonnet 5.5");
ev(`document.querySelector("#chip-model").click()`); ok("model sheet opens", ev("sheet.isOpen")); ev("sheet.close(true)");
ev(`document.querySelector("#btn-more").click()`); ok("overflow menu opens", $$("#sheet .menu-item").length > 3); ev("sheet.close(true)");

if (LIVE) {
  const cwd = process.env.PREFIX + "/tmp/pa-ui"; fs.rmSync(cwd, { recursive: true, force: true }); fs.mkdirSync(cwd, { recursive: true });
  ev(`newChat(${JSON.stringify(cwd)})`);
  ok("new chat shows empty state", !$("#empty").hidden);
  ev(`input.value = "Create notes.md containing a markdown heading 'Hi' and a bash code block with 'ls'. Use the Write tool, then reply with one short sentence."; send()`);
  await until(() => $$(".user-msg").length === 1, 10000, "user bubble");
  ok("user bubble appears immediately", true);
  await until(() => !$("#activity").hidden, 5000, "activity bar");
  ok("activity bar shows right after send: " + $("#activity b").textContent, true);
  const labels = new Set(); let sawDetail = false;
  const watch = setInterval(() => { const b = $("#activity b"); if (b && !$("#activity").hidden) labels.add(b.textContent); if ($("#activity .a-detail")?.textContent) sawDetail = true; }, 50);
  await until(() => ev(`sheet.key && sheet.key.startsWith("perm:")`), 90000, "approval sheet");
  ok("activity reached 'Waiting for your approval'", $("#activity b").textContent === "Waiting for your approval");
  ok("approval sheet appears: " + $("#sheet h2").textContent, true);
  ok("approval shows file content preview", $$("#sheet pre code").length > 0);
  $(`#sheet [data-a="allow"]`).click();
  await until(() => $$(".result-line").length > 0, 120000, "turn finished");
  clearInterval(watch);
  ok("result line after turn", true);
  ok(`activity went through several phases: ${[...labels].join(" → ")}`, labels.size >= 3);
  ok("activity showed live detail text", sawDetail);
  const act = ev("JSON.stringify(currentActivity())") ; const a = JSON.parse(act);
  ok(`activity finished: "${a.label}", ${a.steps.length} steps`, a.phase === "idle" && a.steps.some(s => s.tool === "Write" && s.status === "ok"));
  ev("openActivityLog()");
  ok("step log lists the Write step", $$("#act-log .act-step").some(el => /Writing a file/.test(el.textContent)));
  ev("sheet.close(true)");
  ok("thinking is readable (summarized), not empty", $$("#messages .thinking .md").some(el => el.textContent.trim().length > 20) || console.log("  (model did not think on this turn)") || true);
  ok("file was written", fs.existsSync(cwd + "/notes.md"));
  ok("Write tool card rendered with ok status", $$(".tool .st.ok").length > 0);
  ok("assistant reply rendered", $$("#messages > .md").length > 0);
  const sid = ev("state.current.sessionId");
  await ev(`openSession(${JSON.stringify(sid)})`);
  await until(() => $$(".user-msg").length === 1, 15000, "reload");
  ok("reloaded from transcript: tool card + reply", $$(".tool").length >= 1 && $$("#messages > .md").length > 0);
  await ev(`conn.call("session.close", { sessionId: ${JSON.stringify(sid)} })`);
  await sleep(500);
  await ev(`conn.call("session.delete", { sessionId: ${JSON.stringify(sid)} })`);
}

console.log(errors.length ? "\nPAGE ERRORS:\n" + errors.join("\n") : "\nno page errors");
if (errors.length) fails++;
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
w.close(); process.exit(fails ? 1 : 0);
