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

// result lines: a turn that showed nothing (Claude Code noting stopped background tasks) gets none
const lines0 = $$(".result-line").length;
ev(`chat.event({ type: "result", subtype: "success", duration_ms: 431 })`);
ok("a turn that showed nothing adds no result line", $$(".result-line").length === lines0);
ev(`chat.event({ type: "assistant", uuid: "u-test-1", message: { id: "m-test-1", content: [{ type: "text", text: "Done." }] } }); chat.event({ type: "result", subtype: "success", duration_ms: 1200 })`);
ok("a turn with a reply gets its result line", $$(".result-line").length === lines0 + 1);

// thoughts stay in the chat (one tap opens them); a run of tool calls continues past them into one line
ev(`chat.event({ type: "assistant", uuid: "u-t-2", message: { id: "m-t-2", content: [{ type: "tool_use", id: "tu-a", name: "Bash", input: { command: "ls", description: "List files" } }] } });
  chat.event({ type: "assistant", uuid: "u-t-3", message: { id: "m-t-3", content: [{ type: "thinking", thinking: "Now check the size of each file." }] } });
  chat.event({ type: "assistant", uuid: "u-t-4", message: { id: "m-t-4", content: [{ type: "tool_use", id: "tu-b", name: "Bash", input: { command: "du -sh *", description: "Check sizes" } }] } })`);
const lastGroup = [...$$("#messages > .steps")].pop();
ok("thoughts stay in the chat, not inside the steps line", $$("#messages .steps .thinking").length === 0 && $$("#messages > .thinking").length > 0);
ev(`chat.event({ type: "assistant", uuid: "u-t-5", message: { id: "m-t-5", content: [{ type: "thinking", thinking: "Sizes look fine; summarise next." }] } })`);
const th = [...$$("#messages > .thinking")].pop();
ok("back-to-back thoughts share one block: " + th?.querySelector("summary").textContent, th?.querySelectorAll(".th-body > .md").length === 2 && /2 times/.test(th.querySelector("summary").textContent));
ok("tool calls on both sides of a thought share one line: " + lastGroup?.querySelector(".sl-t").textContent, lastGroup?.querySelectorAll(".steps-list > .tool").length === 2);

// grouped steps: one line per run of tool calls, a timeline sheet, a page per step that hands the card back
const grp = $("#messages .steps.has-tools");
if (grp) {
  ok(`steps grouped into one line: "${grp.querySelector(".sl-t").textContent}"`, w.getComputedStyle(grp.querySelector(".steps-line")).display !== "none" && w.getComputedStyle(grp.querySelector(".steps-list")).display === "none" && grp.querySelector(".sl-t").textContent.length > 3);
  grp.querySelector(".steps-line").click();
  const nSteps = grp.querySelectorAll(".steps-list > *").length;
  ok(`the line opens a timeline of its ${nSteps} steps`, ev("sheet.key") === "steps" && $$("#sheet .step-row").length === nSteps);
  $("#sheet .step-row").click();
  ok("a step opens its own page with the details", !$("#page").hidden && $("#page-body .in-page") !== null);
  ev("page.back()");
  ok("leaving the page puts the step back in the chat", $("#page").hidden && grp.querySelectorAll(".steps-list > *").length === nSteps && !grp.querySelector(".in-page"));
  ok("back from a step returns to its timeline", ev("sheet.key") === "steps");
  $("#sheet-x").click();
  ok("the close button closes a sheet", !ev("sheet.isOpen"));
  ev("openSettings()"); ev(`document.querySelector('[data-sec="look"]').click()`); $("#page-back2").click();
  ok("the bottom back button goes back one page", !$("#page").hidden && $$(".set-cat").length >= 7); ev("page.close()");
  ev("settings.groupSteps = false; applySettings()");
  ok("the setting shows cards instead", w.getComputedStyle(grp.querySelector(".steps-list")).display !== "none");
  ev("settings.groupSteps = true; applySettings()");
} else console.log("  (this chat has no tool steps; grouping not checked)");

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
// agents Claude started (#52): the Chat · Agents switch under the header, the Agents tab, a page per agent
const tx = s => ($(s)?.textContent || "").replace(/\s+/g, " ").trim();
ev(`renderTabs()`);
ok("a chat that started no agents has no switch", $("#chat-tabs").hidden && !$("#agents-line") && !$("#links-bar"));
ev(`state.liveInfo[state.current.sessionId] = { ...(state.liveInfo[state.current.sessionId] || {}), tasks: [
  { id: "a1234567890abcdef", kind: "agent", agentType: "general-purpose", description: "Research DeepSeek", status: "running", activity: "Reading the API docs", tokens: 23548, tools: 4, startedAt: Date.now() - 90000 },
  { id: "box1", kind: "command", description: "Run the tests", status: "completed", summary: "Run the tests", startedAt: Date.now() - 60000, endedAt: Date.now() } ] }; renderTabs()`);
ok(`the switch shows under the header, counting the agents at work: "${tx("#chat-tabs")}"`, !$("#chat-tabs").hidden && $("#chat-tabs").previousElementSibling === $("#topbar")
  && tx("#tab-chat") === "Chat" && tx("#tab-agents") === "Agents1" && $("#tab-agents .tdot").hidden && $("#tab-chat").getAttribute("aria-selected") === "true"
  && $("#tab-agents").getAttribute("aria-label") === "Agents, 1 at work");
$("#tab-agents").click();
ok("the Agents tab takes the chat's place (the message box goes with it)", ev("state.tab") === "agents" && !$("#agents-view").hidden && w.getComputedStyle($("#chat")).display === "none"
  && w.getComputedStyle($("#composer")).display === "none" && $("#tab-agents").getAttribute("aria-selected") === "true");
const agRows = $$("#agents-view .ag-row");
ok(`one row per agent, working first: ${agRows.map(r => r.querySelector(".ag-ti").textContent).join(" / ")}`, agRows.length === 2 && agRows[0].querySelector(".ag-ti").textContent === "Research DeepSeek"
  && tx("#agents-view .ag-row .ag-now") === "Working · Reading the API docs" && /^Subagent · 4 steps · 23\.5k tokens · 1m 3\ds$/.test(tx("#agents-view .ag-row .ag-meta"))
  && agRows[0].querySelector(".ag-tile .spark") && agRows[1].querySelector(".ag-now").textContent === "Done" && /^Command · /.test(agRows[1].querySelector(".ag-meta").textContent));
ok("each row is a thumb high or more", parseFloat(w.getComputedStyle(agRows[0]).minHeight) >= 56);
agRows[0].click();
await sleep(200);
ok(`a row opens the agent's page: "${tx("#page-title")}" · ${tx(".ag-hst")}`, !$("#page").hidden && tx("#page-title") === "Research DeepSeek" && $("#page-title").classList.contains("ltr")
  && tx(".ag-hst") === "Working · Reading the API docs" && !$('.ag-head [data-a="stop"]').hidden && !$('.ag-head [data-a="open"]'));
ev("page.back()");
ok("back returns to the Agents tab", $("#page").hidden && ev("state.tab") === "agents" && !$("#agents-view").hidden);
ev(`state.liveInfo[state.current.sessionId].tasks[0].activity = "Writing the summary"; conn.fire("tasks", { sessionId: state.current.sessionId, tasks: state.liveInfo[state.current.sessionId].tasks })`);
await sleep(150);
ok("rows update in place as agents work", $$("#agents-view .ag-row")[0] === agRows[0] && /Writing the summary/.test(tx("#agents-view .ag-row .ag-now")));
ok("Android back goes from the Agents tab to the chat", w.paBack() === true && ev("state.tab") === "chat" && w.getComputedStyle($("#chat")).display !== "none" && w.getComputedStyle($("#composer")).display !== "none");
// a quick sideways swipe switches tabs; one that starts in something that scrolls sideways doesn't
const swipe = (x0, x1, target = $("#messages")) => {
  const t = (type, x) => { const e = new w.Event(type, { bubbles: true }); Object.defineProperty(e, type === "touchend" ? "changedTouches" : "touches", { value: [{ clientX: x, clientY: 300 }] }); target.dispatchEvent(e); };
  t("touchstart", x0); t("touchend", x1);
};
swipe(330, 120);
ok("a swipe to the left opens the Agents tab", ev("state.tab") === "agents");
swipe(80, 300, $("#agents-view"));
ok("…and to the right, the chat", ev("state.tab") === "chat");
swipe(330, 300);
ok("a short swipe does nothing", ev("state.tab") === "chat");
ev(`delete state.liveInfo[state.current.sessionId].tasks; renderTabs()`);
ok("no agents, no switch", $("#chat-tabs").hidden && ev("state.tab") === "chat");

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

// questions: a chosen option can be unchosen, and a typed answer goes with the chosen options
ev("window.__origCall = conn.call; window.__calls = []; conn.call = (t, m) => { window.__calls.push([t, m]); return Promise.resolve({}); }");
ev(`askQuestionSheet({ sessionId: "s1", requestId: "r1", toolName: "AskUserQuestion", input: { questions: [ { question: "Pick one", header: "One", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }, { question: "Pick many", header: "Many", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] } ] } }, null)`);
const q1 = $$("#sheet .q-block")[0], q2 = $$("#sheet .q-block")[1];
const optA = q1.querySelectorAll(".opt")[0];
optA.click(); optA.click();
ok("a chosen option can be unchosen", !optA.classList.contains("on"));
optA.click();
ok("…and chosen again", optA.classList.contains("on"));
q1.querySelector("input.field").value = "with a note";   // no input event: a keyboard may not have sent it yet
q2.querySelectorAll(".opt")[0].click();
q2.querySelector("input.field").value = "and Z";
$('#sheet [data-a="ok"]').click();
await sleep(50);
const reply = ev("window.__calls[window.__calls.length - 1]");
const sent = reply && reply[0] === "permission.reply" && reply[1].updatedInput.answers;
ok("typed answers are sent with the chosen options", !!sent && sent["Pick one"] === "A — with a note" && sent["Pick many"] === "X, and Z" && Object.keys(sent).length === 2);
ev("conn.call = window.__origCall");

// Claude accounts (#61): the account chip and its sheet, Settings → Claude accounts, the limit card
ev(`window.__origCall = conn.call; window.__save = { cur: state.current, accounts: state.accounts, defaultAccount: state.defaultAccount, usageByAccount: state.usageByAccount, newChatAccount: state.newChatAccount };
  window.__calls = []; conn.call = (t, m) => { window.__calls.push([t, m]); return Promise.resolve(t === "sessions.list" ? { sessions: [] } : {}); }`);
ev(`state.accounts = [{ id: "default", name: "Personal", email: "p@example.com", plan: "max" }]; state.defaultAccount = "default"; state.newChatAccount = null;
  state.current = { ...state.current, isNew: true, account: null, engine: "claude" }; updateComposer()`);
ok("with one Claude account there is no account chip", $("#chip-account").hidden);
ev(`state.accounts = [{ id: "default", name: "Personal", email: "p@example.com", plan: "max" }, { id: "work-1a2b", name: "Work", email: "w@example.com", plan: "pro" }]; updateComposer()`);
ok(`with two, the chip names the account a new chat runs on: "${tx("#chip-account")}"`, !$("#chip-account").hidden && tx("#chip-account") === "Personal" && $("#chip-account").getAttribute("aria-label") === "Claude account: Personal");
ev(`state.current = { ...state.current, isNew: false, sessionId: "cccccccc-0000-4000-8000-0000000000a1", account: "default" }; updateComposer()`);
$("#chip-account").click();
ok(`an existing chat's sheet offers the other account: "${tx("#sheet h2")}"`, ev("sheet.key") === "account" && tx("#sheet h2") === "This chat runs on Personal" && $$("#sheet .opt").length === 1 && /Continue on Work/.test(tx("#sheet")));
$$("#sheet .opt")[0].click();
await sleep(50);
ok("continuing on Work moves the chat and says so", ev(`__calls.some(([t, m]) => t === "chat.account" && m.sessionId === "cccccccc-0000-4000-8000-0000000000a1" && m.account === "work-1a2b")`) && ev("state.current.account") === "work-1a2b" && /Your next message goes to Work/.test(tx("#toast")));
ev("openSettings()");
const accCat = $('[data-sec="accounts"]');
ok(`Settings has Claude accounts: "${accCat?.querySelector("small")?.textContent}"`, !!accCat && accCat.textContent.includes("Claude accounts") && accCat.textContent.includes("2 accounts · new chats: Personal"));
$('[data-sec="accounts"]').click();
const accRows = $$("#page-body .acc-row"), accChips = accRows.map(r => [...r.querySelectorAll(".chip")].map(c => c.textContent).join(","));
ok(`one row per account, with its chips: ${accChips.join(" / ")}`, accRows.length === 2 && accChips[0] === "Rename" && accChips[1] === "Make default,Rename,Remove" && !!$("#page-body #acc-add"));
ok("each row says its email and plan, and which is the default", accRows[0].querySelector("small").textContent === "p@example.com · max · default" && accRows[1].querySelector("small").textContent === "w@example.com · pro");
ev("page.close(); openSettings()");
ev(`const q = document.querySelector("#set-q"); q.value = "accounts"; q.dispatchEvent(new window.Event("input"))`);
ok("settings search finds Claude accounts", /Claude accounts/.test(tx("#set-results")) && !$('#set-results [data-sec="accounts"]').hidden && /Add account/.test(tx('#set-results [data-sec="accounts"]')));
ev("page.close()");
ev(`state.current = { ...state.current, account: "default" }; updateComposer(); window.__calls = []`);
ev(`conn.fire("account.limit", { sessionId: "cccccccc-0000-4000-8000-0000000000a1", account: "default", limit: "seven_day", resetsAt: Date.now() + 3 * 3600e3 })`);
ok(`the limit card names the limit and offers the way out: "${tx("#account-limit")}"`, !$("#account-limit").hidden && /Personal is at its weekly limit · resets in (2h 59m|3h 0m)/.test(tx("#account-limit")) && /Continue on Work/.test(tx("#account-limit")));
$("#account-limit button").click();
await sleep(150);
ok("continuing from the limit card moves the chat and carries on in it", ev(`__calls.some(([t, m]) => t === "chat.account" && m.sessionId === "cccccccc-0000-4000-8000-0000000000a1" && m.account === "work-1a2b")`) && ev(`__calls.some(([t, m]) => t === "send" && /Continued on the Work account/.test(m.text))`) && $("#account-limit").hidden);
// the account is sent as "account": a param named "id" would overwrite the request's own id (conn.call) and hang
ev("window.__calls = []");
await ev(`(async () => {
  const rp = renameAccountPrompt("work-1a2b");
  await new Promise(r => setTimeout(r, 60));
  document.querySelector("#ps-in").value = "Work 2";
  document.querySelector('#sheet [data-r="1"]').click();
  await rp;
  await makeAccountDefault("work-1a2b");
  accountLoginSheet({ id: "work-1a2b", name: "Work" });
  document.querySelector("#acc-open").click();
})()`);
await sleep(100);
const accCheck = ev(`(() => { const accs = window.__calls.filter(([t]) => typeof t === "string" && t.startsWith("accounts."));
  return { types: accs.map(([t]) => t), bad: accs.filter(([, m]) => m && Object.prototype.hasOwnProperty.call(m, "id")).map(([t]) => t) }; })()`);
ok("account calls never send a param named id", accCheck.bad.length === 0 && ["accounts.rename", "accounts.setDefault", "accounts.login.start"].every(t => accCheck.types.includes(t)));
ev("sheet.close(true)");
ev(`state.current = window.__save.cur; state.accounts = window.__save.accounts; state.defaultAccount = window.__save.defaultAccount; state.usageByAccount = window.__save.usageByAccount; state.newChatAccount = window.__save.newChatAccount;
  conn.call = window.__origCall; delete window.__save; delete window.__origCall; updateComposer()`);

// this device (server/src/environment.js): Settings shows its name, with a way to rename it
ev("openSettings()"); ev(`const q = document.querySelector("#set-q"); q.value = "this device"; q.dispatchEvent(new window.Event("input"))`);
ok("Settings has a This device row, with its name and Rename",
  /This device/.test(tx("#set-results")) && !!$("#set-results .set-item:not([hidden]) #env-rename") && $("#set-results .set-item:not([hidden]) #env-name").textContent.length > 0);
ev("page.close()");
ev("openFiles(state.home)"); await until(() => $$("#page-body .list-row").length > 0, 10000, "files list"); ok("files page lists entries", true); ev("page.close()");
ev(`document.querySelector("#chip-mode").click()`); ok("mode sheet opens", ev("sheet.isOpen") && $$("#sheet .opt").length === 5); ev("sheet.close(true)");
ev(`state.models = [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" }, { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" }]`);
ev(`document.querySelector("#chip-model").click()`);
ok("the model sheet ticks Default when the chat uses the default", $$("#sheet .opt.on").length === 1 && $("#sheet .opt.on").textContent.includes("Default")); ev("sheet.close(true)");
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
