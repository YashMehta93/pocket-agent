// Screen test for DeepSeek (#44): the engine chip and its sheet, Settings → DeepSeek and the key sheet, the worker
// approval sheet, the Usage section, the links bar, the drawer and the worker card. It needs no key and runs no turns:
// it loads the real UI from the server at PA_PORT in jsdom and answers the deepseek.* requests itself with a fake
// status (docs/PROTOCOL.md), so it works the same against a server with or without DeepSeek support.
const PORT = process.env.PA_PORT || 8765;
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs"; import os from "node:os";

const token = fs.readFileSync(os.homedir() + "/.pocket-agent/token", "utf8").trim();
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, what = "condition") { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await sleep(50); } throw new Error("timeout: " + what); }
let fails = 0;
const ok = (name, c) => { console.log(c ? "PASS" : "FAIL", name); if (!c) fails++; };
const text = s => ($(s)?.textContent || "").replace(/\s+/g, " ").trim();
/** A tap that must land: for 400 ms after any sheet closes, a tap on a handoff line is ignored, so that the finger
 *  that closed the sheet doesn't also open what was under it (#44). Wait that out instead of depending on machine speed. */
async function tap(el) { await until(() => ev("Date.now() - (sheet.closedAt || 0) >= 400"), 5000, "the sheet-close tap guard"); el.click(); }

await new Promise(r => w.addEventListener("load", r));
await until(() => ev("conn.ok") && ev("state.home"), 20000, "connect + hello");
await sleep(300);

// The fake server side of DeepSeek: status, key, settings. Everything else still goes to the real server.
ev(`
  window.__fake = () => ({ ready: true, keyHint: "a1b2", note: null,
    balance: { total: "4.20", currency: "USD", available: true, at: Date.now() - 120000 }, balanceError: null,
    spend: { today: 0.12, month: 1.4, cap: 0, searchesToday: 0 }, price: { peak: false, until: Date.now() + 3 * 3600e3 },
    settings: { defaultModel: "deepseek-flash[1m]", effort: null, dailyCapUsd: 0, workerMode: "acceptEdits", toDeepseek: true, toClaude: true, blockedFolders: [] },
    models: [{ value: "deepseek-flash[1m]", displayName: "DeepSeek Flash", description: "Fast and cheap. Sees images.", efforts: ["low", "high", "max"], images: true },
      { value: "deepseek-v4-pro[1m]", displayName: "DeepSeek V4 Pro", description: "Stronger, about 3–4× the price. No images.", efforts: ["low", "high", "max"], images: false }] });
  window.__ds = __fake(); window.__calls = [];
  const real = conn.call.bind(conn);
  conn.call = (t, m = {}) => {
    __calls.push([t, m]);
    const reply = () => Promise.resolve({ deepseek: JSON.parse(JSON.stringify(__ds)) });
    if (t === "deepseek.status") return reply();
    if (t === "deepseek.setKey") {
      if (m.key !== "sk-good-key-0123456789") return Promise.reject(Object.assign(new Error("DeepSeek didn't accept that key."), { code: "BAD_KEY" }));
      Object.assign(__ds, { ready: true, keyHint: m.key.slice(-4) }); return reply();
    }
    if (t === "deepseek.settings") { Object.assign(__ds.settings, m.settings); if ("dailyCapUsd" in m.settings) __ds.spend.cap = m.settings.dailyCapUsd; return reply(); }
    if (t === "deepseek.removeKey") { Object.assign(__ds, { ready: false, keyHint: null, balance: null }); return reply(); }
    if (t === "send" && window.__sendFails) { __sent = m; return Promise.reject(Object.assign(new Error(__sendFails.message), { code: __sendFails.code })); }
    return real(t, m);
  };
`);

// 1. The engine chip: hidden without a key, "Claude" with one
ev(`newChat(); state.deepseek = { ...__fake(), ready: false }; updateComposer()`);
ok("no key: no engine chip, the composer is as before", $("#chip-engine").hidden && w.document.querySelector("#input").placeholder === "Message Claude…");
ev(`state.deepseek = __fake(); updateComposer()`);
ok("with a key the engine chip shows: " + text("#chip-engine"), !$("#chip-engine").hidden && text("#chip-engine") === "Claude" && $("#chip-engine").getAttribute("aria-label") === "Engine: Claude");
ok("the chip sits before the mode chip (the account chip is between), the same small chip", $("#chip-engine").nextElementSibling === $("#chip-account") && $("#chip-account").nextElementSibling === $("#chip-mode") && $("#chip-engine").classList.contains("chip") && w.getComputedStyle($("#composer .chips")).flexWrap === "wrap");
ev(`state.current.isNew = false; updateComposer()`);
ok("an existing Claude chat keeps the composer as it was (no engine chip)", $("#chip-engine").hidden);
ev(`state.current.isNew = true; updateComposer()`);

// 2. Choosing DeepSeek for a new chat
$("#chip-engine").click();
ok("a new chat's engine sheet offers Claude and DeepSeek", ev("sheet.key") === "engine" && text("#sheet h2") === "Run this chat on" && $$("#sheet .opt").length === 2
  && /Pay per use from your DeepSeek credit \(\$4\.20 left\)\. Your messages, files and memory go to DeepSeek\./.test(text("#sheet")));
$$("#sheet .opt")[1].click();
ok("the chip says DeepSeek, in its accent", text("#chip-engine") === "DeepSeek" && $("#chip-engine").classList.contains("engine-ds") && $("#chip-engine").getAttribute("aria-label") === "Engine: DeepSeek");
ok(`the model chip names the DeepSeek model ("${text("#chip-model")}", spoken "${$("#chip-model").getAttribute("aria-label")}")`,
  text("#chip-model") === "Flash" && $("#chip-model").getAttribute("aria-label") === "Model: DeepSeek Flash" && ev(`modelLabel("deepseek-flash[1m]")`) === "DeepSeek Flash" && ev(`modelLabel("deepseek-v4-pro")`) === "DeepSeek V4 Pro");
ok("the placeholder says DeepSeek, and the header too", ev("input.placeholder") === "Message DeepSeek…" && /· DeepSeek/.test(text("#chat-sub")) && ev("state.current.engine") === "deepseek" && ev("state.current.model") === "deepseek-flash[1m]");
$("#chip-mode").click();
ok(`the mode sheet has no Auto mode (${$$("#sheet .opt").length} modes) and names DeepSeek`, !/Auto mode/.test(text("#sheet")) && $$("#sheet .opt").length === 4 && /How much DeepSeek can do/.test(text("#sheet")));
ev("sheet.close(true)");
$("#chip-model").click();
ok("the model sheet lists DeepSeek's models", $$("#sheet #models .opt").map(o => o.querySelector(".ot div").textContent).join() === "DeepSeek Flash,DeepSeek V4 Pro" && $("#sheet #models .opt.on")?.textContent.includes("DeepSeek Flash"));
ok("its effort seg shows low/high/max, with max (the default) on", $$("#sheet #efforts button").map(b => b.textContent).join() === "low,high,max" && text("#sheet #efforts .on") === "max");
$$("#sheet #efforts button")[1].click();
ok("choosing an effort shows on the chip", text("#chip-model") === "Flash · high" && ev("state.current.effort") === "high");
ev(`applySetting({ effort: null })`);
// a new chat sends its engine; the server's DeepSeek errors keep the draft, and the chat stays new
ev(`window.__sendFails = { code: "NO_DEEPSEEK_KEY", message: "Add your DeepSeek key in Settings → DeepSeek first." }; input.value = "hello deepseek"; send()`);
await sleep(200);
ok("send() says which engine a new chat runs on", ev("__sent?.engine") === "deepseek" && ev("__sent?.model") === "deepseek-flash[1m]");
ok("a refused send keeps the draft and the new chat, and shows why", ev("input.value") === "hello deepseek" && ev("state.current.isNew") === true && /Add your DeepSeek key/.test(text("#toast")) && !$(".note.err"));
ev(`window.__sendFails = null; input.value = ""; autosize()`);
// an existing chat can't change engine
ev(`state.current.isNew = false; state.current.sessionId = "11111111-0000-4000-8000-00000000d5e1"; updateComposer()`);
$("#chip-engine").click();
ok("an existing chat's sheet: it stays on its engine, with a way to a new Claude chat", text("#sheet h2") === "This chat runs on DeepSeek" && /A chat stays on one engine/.test(text("#sheet"))
  && text('#sheet [data-a="new"]') === "New Claude chat here");
$('#sheet [data-a="new"]').click();
ok("…which opens a new Claude chat in the same folder", ev("state.current.isNew") && ev("state.current.engine") === "claude" && text("#chip-engine") === "Claude" && ev("input.placeholder") === "Message Claude…");
// no key: the DeepSeek option leads to Settings
ev(`state.deepseek = { ...__fake(), ready: false }; renderEngineChip(); engineSheet()`);
ok("without a key, DeepSeek says to add one first", /Add your key in Settings first/.test(text("#sheet")));
$$("#sheet .opt")[1].click();
ok("…and opens Settings → DeepSeek", !$("#page").hidden && text("#page-title") === "DeepSeek" && text("#ds-key") === "Add" && ev("state.current.engine") === "claude");
ev("page.close()");

// 3. Settings → DeepSeek
ev(`state.deepseek = null; openSettings()`);
ok("a server without DeepSeek: no DeepSeek category", !$('[data-sec="deepseek"]')); ev("page.close()");
ev(`state.deepseek = { ...__fake(), ready: false }; openSettings()`);
ok("no key yet: the category says so", /Not set up/.test(text('[data-sec="deepseek"]')));
ok("the category sits right after Claude accounts, which is right after Claude and connection",
  $('[data-sec="deepseek"]')?.previousElementSibling?.dataset.sec === "accounts" && $('[data-sec="accounts"]')?.previousElementSibling?.dataset.sec === "claude"); ev("page.close()");
ev(`state.deepseek = __fake(); openSettings()`);
ok(`with a key it shows the balance and model: "${text('[data-sec="deepseek"] small')}"`, text('[data-sec="deepseek"] small') === "$4.20 left · Flash");
$('[data-sec="deepseek"]').click();
const rows = $$("#page-body .set-row .l").map(l => l.firstChild.textContent.trim());
ok("its page has every row: " + rows.join(" | "), ["API key", "Balance", "Spent", "Model for new DeepSeek chats", "New chats start on", "Claude can send work to DeepSeek",
  "DeepSeek can ask Claude", "Keep DeepSeek out of", "Remove key"].every(r => rows.includes(r)) && /Saved · ends a1b2/.test(text("#page-body")));
ok("there's no workers-mode row: a worker gets the calling chat's mode", !/Workers may/.test(text("#page-body")) && /The worker gets the chat's mode/.test(text("#page-body")));
ok("spend shows with no daily limit by default", text("#ds-spent") === "Today $0.12 · this month $1.40 · no daily limit" && /\$4\.20 left · (2m ago|just now)/.test(text("#ds-bal")));
ok("the key stays private and out of backups (footer)", /Your key stays on this phone in a private file\. Backups skip it\./.test(text("#page-body")));
const local = ev("JSON.stringify(settings)");
$('#page-body .switch[data-ds="toClaude"]').click();
await sleep(50);
ok("a DeepSeek switch saves to the server, not to this phone's settings", ev(`__calls.some(([t, m]) => t === "deepseek.settings" && m.settings.toClaude === false)`) && ev("JSON.stringify(settings)") === local
  && !$('#page-body .switch[data-ds="toClaude"]').classList.contains("on"));
$('#page-body #ds-model button[data-v="deepseek-v4-pro[1m]"]').click();
await sleep(50);
ok("the model seg saves the default model", ev(`__ds.settings.defaultModel`) === "deepseek-v4-pro[1m]" && /V4 Pro/.test(text('#page-body #ds-model .on')));
ev(`__ds.settings.defaultModel = "deepseek-flash[1m]"; __ds.settings.toClaude = true; page.close(); openSettings()`);
ev(`const q = document.querySelector("#set-q"); q.value = "balance"; q.dispatchEvent(new window.Event("input"))`);
ok("searching \"balance\" finds the DeepSeek row", !$('#set-results section[data-sec="deepseek"]').hidden && /Balance/.test(text('#set-results section[data-sec="deepseek"] .set-item:not([hidden])')));
ev(`const q = document.querySelector("#set-q"); q.value = "office"; q.dispatchEvent(new window.Event("input"))`);
ok("searching \"office\" finds the folders row", /Keep DeepSeek out of/.test(text('#set-results section[data-sec="deepseek"]')) && !/Balance/.test(text('#set-results section[data-sec="deepseek"] .set-item:not([hidden])')));
ev("page.close()");
// the key sheet
ev("keySheet()");
ok("the key field is a password field, never autofilled or spell-checked", $("#ds-key-in")?.type === "password" && $("#ds-key-in").getAttribute("autocomplete") === "off" && $("#ds-key-in").getAttribute("spellcheck") === "false");
ev(`document.querySelector("#ds-key-in").value = "sk-wrong"; document.querySelector('#sheet [data-a="save"]').click()`);
await until(() => !$("#ds-key-err").hidden, 3000, "key error");
ok("a key DeepSeek refuses: an inline error, the field cleared", text("#ds-key-err") === "DeepSeek didn't accept that key." && $("#ds-key-in").value === "" && ev("sheet.key") === "ds-key");
ev(`document.querySelector("#ds-key-in").value = "sk-good-key-0123456789"; document.querySelector('#sheet [data-a="save"]').click()`);
await until(() => !ev("sheet.isOpen"), 3000, "key saved");
ok(`a good key: "${text("#toast")}"`, /^DeepSeek is ready · \$4\.20 left$/.test(text("#toast")) && ev("state.deepseek.keyHint") === "6789" && $("#ds-key-in").value === "" && !ev("JSON.stringify(state)").includes("sk-good-key"));

// 4. The approval sheet for a worker
const task = "# Add the CONTRIBUTORS file\\n\\nSteps:\\n\\n- Create `CONTRIBUTORS`\\n- List the authors from git log\\n\\nCheck: `test -s CONTRIBUTORS`";
ev(`newChat(state.home); state.current.isNew = false; state.current.sessionId = "22222222-0000-4000-8000-0000000000aa"; state.current.title = "Plan the tidy-up";
  state.liveInfo[state.current.sessionId] = { sessionId: state.current.sessionId, state: "waiting", cwd: state.home + "/projects/demo", permissionMode: "acceptEdits", engine: "claude" };
  state.pending = [{ requestId: "r-ds-1", sessionId: state.current.sessionId, toolName: "mcp__pocket__deepseek_task", toolUseID: "toolu_ds1",
    input: { task: "${task}", title: "Add the CONTRIBUTORS file" }, suggestions: [], at: Date.now() }];
  showNextPermission()`);
ok(`the sheet asks "${text("#sheet h2")}"`, text("#sheet h2") === "Send this to DeepSeek?" && ev("sheet.key") === "perm:r-ds-1");
ok(`it says where and how the worker runs: "${text("#dl-line")}"`, text("#dl-line") === "New DeepSeek chat · ~/projects/demo · Flash · Auto-edit · today $0.12");
ok("the task is shown as Markdown, its title once", !$("#dl-title") && $("#dl-task h1")?.textContent === "Add the CONTRIBUTORS file" && $$("#dl-task li").length === 2 && $("#dl-task code") !== null);
ev("sheet.close(true); state.liveInfo[state.current.sessionId].permissionMode = 'auto'; showNextPermission()");
ok("a DeepSeek worker of an Auto chat runs in Auto-edit (DeepSeek has no Auto)", / · Flash · Auto-edit · /.test(text("#dl-line")));
ev("sheet.close(true); state.liveInfo[state.current.sessionId].permissionMode = 'bypassPermissions'; state.deepseek.settings.workerMode = 'default'; showNextPermission()");
ok("a worker mode set in Settings wins over the chat's", / · Flash · Ask · /.test(text("#dl-line")));
ev("sheet.close(true); state.liveInfo[state.current.sessionId].permissionMode = 'acceptEdits'; state.deepseek.settings.workerMode = null; showNextPermission()");
ok("the buttons: send; send and don't ask again in this chat; deny; deny & say why", text('#sheet [data-a="allow"]') === "Send to DeepSeek" && text('#sheet [data-a="always"]') === "Send, and don't ask again in this chat"
  && $('#sheet [data-a="deny"]') && $('#sheet [data-a="tell"]'));
$('#sheet [data-a="always"]').click();
await sleep(50);
ok("\"don't ask again\" allows it for the rest of the chat (always: true)", ev(`__calls.some(([t, m]) => t === "permission.reply" && m.requestId === "r-ds-1" && m.behavior === "allow" && m.always === true)`) && !ev("sheet.isOpen"));
ev(`state.pending = [{ requestId: "r-cl-1", sessionId: state.current.sessionId, toolName: "mcp__pocket__claude_task", toolUseID: "toolu_cl1", input: { task: "Review the CONTRIBUTORS change.", model: "sonnet" }, suggestions: [] }]; showNextPermission()`);
ok(`asking Claude: "${text("#dl-line")}"`, text("#sheet h2") === "Ask Claude?" && text('#sheet [data-a="allow"]') === "Ask Claude" && text("#dl-line") === "New Claude chat · ~/projects/demo · Sonnet · Auto-edit · uses your Claude plan");
ev("sheet.close(true)");
ev(`state.pending = [{ requestId: "r-ds-2", sessionId: state.current.sessionId, toolName: "mcp__pocket__deepseek_task", input: { task: "Fix the failing check.", continue_chat: "33333333-0000-4000-8000-0000000000bb" }, suggestions: [] }];
  state.links["33333333-0000-4000-8000-0000000000bb"] = { parent: state.current.sessionId, engine: "deepseek", title: "Add the CONTRIBUTORS file" }; showNextPermission()`);
ok(`a follow-up names its worker: "${text("#dl-line")}"`, /^Follow-up to Add the CONTRIBUTORS file · Auto-edit · today \$0\.12$/.test(text("#dl-line")));
ev("sheet.close(true); state.pending = []; state.links = {}; delete state.liveInfo[state.current.sessionId]");

// 5. The Usage sheet's DeepSeek section
ev(`state.current.engine = "deepseek"; state.liveInfo[state.current.sessionId] = { sessionId: state.current.sessionId, state: "idle", engine: "deepseek", spend: 0.031 }; openUsage()`);
await sleep(300);
const usage = text("#usage-sheet .u-ds");
ok(`the Usage sheet shows DeepSeek: "${usage}"`, /DeepSeek/.test(usage) && /\$4\.20 left/.test(usage) && /from DeepSeek · (2m ago|just now)/.test(usage)
  && /\$0\.12 today · \$1\.40 this month/.test(usage) && /This chat \$0\.03(?!\d)/.test(usage) && /Half price now · until /.test(usage) && /estimated from token counts/.test(usage));
ok("it sits before the plan limits", $("#usage-sheet .u-ds") && [...$$("#usage-sheet .u-sec")].map(x => x.textContent).join() === "DeepSeek,Plan limits");
ev(`__ds.spend.cap = 3; __ds.spend.today = 2.85; __ds.price = { peak: true, until: Date.now() + 3600e3 }; conn.fire("deepseek", { deepseek: { spend: __ds.spend, price: __ds.price } })`);
await sleep(100);
ok("a daily limit draws a meter, warning near it; peak price shows", $("#usage-sheet .ds-bar[role=meter]")?.getAttribute("aria-valuemax") === "3" && $("#usage-sheet .ds-row.warn") !== null
  && /\$2\.85 of \$3 today/.test(text("#usage-sheet")) && /Peak price now · half price from /.test(text("#usage-sheet")));
ev(`conn.fire("deepseek", { deepseek: { balance: { total: "0.00", currency: "USD", available: false, at: Date.now() } } })`);
await sleep(100);
ok("out of credit says so, and where to top up", /Out of credit Top up at platform\.deepseek\.com/.test(text("#usage-sheet .u-ds")));
ev(`sheet.close(true); state.current.engine = "claude"; delete state.liveInfo[state.current.sessionId]; __ds = __fake(); state.deepseek = __fake()`);

// 6. The Chat · Agents switch and the Agents tab, for workers (#52)
const P = "44444444-0000-4000-8000-0000000000cc", C = "55555555-0000-4000-8000-0000000000dd";
ev(`state.current = { sessionId: "${P}", cwd: state.home, title: "Plan the tidy-up", isNew: false, lastSeq: 0, engine: "claude" }; state.links = {}; chat.reset(); hideEmpty(); updateHeader()`);
ok("no workers, no switch, and no links bar or agents line any more", $("#chat-tabs").hidden && !$("#links-bar") && !$("#agents-line"));
ev(`conn.fire("link", { parent: "${P}", child: "${C}", engine: "deepseek", title: "T1", toolUseId: "toolu_link1" })`);
await sleep(150);
ok(`a worker starting shows the switch: "${text("#chat-tabs")}"`, !$("#chat-tabs").hidden && text("#tab-agents") === "Agents1" && ev(`chatAgents()[0].status`) === "starting");
ev(`state.liveInfo["${C}"] = { sessionId: "${C}", state: "running", engine: "deepseek", parent: "${P}", spend: 0.0031 };
  state.activity["${C}"] = { phase: "tool", label: "Running a command", detail: "npm test", turnStart: Date.now() - 72000, since: Date.now(), steps: [{ kind: "tool" }, { kind: "tool" }, { kind: "note" }], tokens: {} };
  conn.fire("state", { sessionId: "${C}", state: "running", info: state.liveInfo["${C}"] })`);
await sleep(150);
$("#tab-agents").click();
ok(`the Agents tab lists it, live: "${text("#agents-view .ag-row")}"`, $$("#agents-view .ag-row").length === 1 && text("#agents-view .ag-ti") === "T1"
  && text("#agents-view .ag-now") === "Working · Running a command: npm test" && /^DeepSeek · 2 steps · \$0\.003 · 1m 1\ds$/.test(text("#agents-view .ag-meta"))
  && $("#agents-view .ag-tile").classList.contains("deepseek") && $("#agents-view .ag-meta").classList.contains("ds"));
ev(`conn.fire("activity", { sessionId: "${C}", activity: { ...state.activity["${C}"], detail: "npm run lint" }, spend: 0.0052 })`);
await sleep(150);
ok("its cost and what it's doing follow its activity events", /npm run lint/.test(text("#agents-view .ag-now")) && /\$0\.005/.test(text("#agents-view .ag-meta")));
ev(`state.pending = [{ requestId: "r-w", sessionId: "${C}", toolName: "Bash", input: { command: "ls" }, engine: "deepseek", parent: "${P}", title: "T1" }];
  conn.fire("permission.request", state.pending[0])`);
await sleep(150);
ok(`…needs you when it asks (the switch gets a dot): "${text("#agents-view .ag-now")}"`, text("#agents-view .ag-now") === "Needs you · Wants to run ls" && !$("#tab-agents .tdot").hidden
  && $("#agents-view .ag-st.needs") !== null && $("#agents-view .ag-dot") !== null && /needs you/.test($("#tab-agents").getAttribute("aria-label")));
ev(`sheet.close(true)`);
for (const [i, t] of ["T2", "T3"].entries()) ev(`conn.fire("link", { parent: "${P}", child: "66666666-0000-4000-8000-00000000000${i}", engine: "${i ? "claude" : "deepseek"}", title: "${t}", toolUseId: "toolu_x${i}" });
  conn.fire("link", { parent: "${P}", child: "66666666-0000-4000-8000-00000000000${i}", engine: "${i ? "claude" : "deepseek"}", title: "${t}", toolUseId: "toolu_x${i}", result: "${i ? "failed" : "done"}", steps: ${3 + i}, ms: 65000, usd: ${i ? "null" : 0.004}, endedAt: Date.now() - ${i + 1}000 })`);
await sleep(150);
const agRows = $$("#agents-view .ag-row").map(r => r.querySelector(".ag-ti").textContent + ": " + r.querySelector(".ag-now").textContent + " | " + r.querySelector(".ag-meta").textContent);
ok(`every worker gets a row, the one that needs you first: ${agRows.join(" / ")}`, agRows.length === 3 && /^T1: Needs you/.test(agRows[0])
  && agRows.includes("T2: Done | DeepSeek · 3 steps · $0.004 · 1m 5s") && agRows.includes("T3: Failed | Claude · 4 steps · 1m 5s") && $$("#agents-view .ag-tile.claude").length === 1
  && $$("#agents-view .ag-st.bad").length === 1);
ok("the switch counts only the ones at work", text("#tab-agents") === "Agents1");
ev("setTab('chat')");

// 7. The drawer: workers nested under the chat that started them, folded
const W1 = "77777777-0000-4000-8000-0000000000e1", W2 = "77777777-0000-4000-8000-0000000000e2", ORPHAN = "77777777-0000-4000-8000-0000000000e3";
ev(`state.links = {}; state.pending = []; delete state.liveInfo["${C}"]; state.openKids = new Set();
  state.sessions = [{ sessionId: W1, title: "Worker one", cwd: state.home + "/projects/demo", lastModified: Date.now(), engine: "deepseek", parent: "${P}" },
    { sessionId: W2, title: "Worker two", cwd: state.home + "/projects/demo", lastModified: Date.now(), engine: "claude", parent: "${P}" },
    { sessionId: "${P}", title: "Plan the tidy-up", cwd: state.home + "/projects/demo", lastModified: Date.now() - 5000 },
    { sessionId: ORPHAN, title: "Lost worker", cwd: state.home, lastModified: Date.now(), engine: "deepseek", parent: "99999999-0000-4000-8000-00000000dead" },
    { sessionId: "88888888-0000-4000-8000-0000000000ff", title: "A DeepSeek chat", cwd: state.home, lastModified: Date.now(), engine: "deepseek" }, ...state.sessions]; renderSessions()`.replaceAll("W1", `"${W1}"`).replaceAll("W2", `"${W2}"`).replaceAll("ORPHAN", `"${ORPHAN}"`));
const titles = () => $$("#session-list > .sess .t div:first-child").map(d => d.textContent);
ok(`workers aren't top-level chats any more: ${titles().slice(0, 4).join(" / ")}`, !titles().includes("Worker one") && !titles().includes("Worker two") && titles().includes("Plan the tidy-up"));
const kids = $("#session-list .sess-kids");
ok(`under their chat, folded: "${text("#session-list .kids-toggle")}"`, kids && kids.previousElementSibling.textContent.includes("Plan the tidy-up") && text("#session-list .kids-toggle") === "› 2 workers"
  && !kids.classList.contains("open") && $$("#session-list .sess.kid").length === 0 && $("#session-list .kids-toggle").getAttribute("aria-expanded") === "false");
ok("a worker whose chat isn't listed stays top-level, and says it's a worker", titles().includes("Lost worker") && /· DeepSeek worker$/.test($$("#session-list > .sess").find(r => r.textContent.includes("Lost worker")).querySelector(".meta").textContent));
$("#session-list .kids-toggle").click();
ok(`a tap unfolds them: ${$$("#session-list .sess.kid .meta").map(m => m.textContent).join(" / ")}`, $$("#session-list .sess.kid").length === 2 && $("#session-list .sess-kids").classList.contains("open")
  && $$("#session-list .sess.kid .meta").every(m => !/worker/.test(m.textContent)) && /· DeepSeek$/.test($$("#session-list .sess.kid .meta")[0].textContent));
$("#session-list .kids-toggle").click();
ok("…and folds them again", $$("#session-list .sess.kid").length === 0);
ev(`state.pending = [{ requestId: "r-k", sessionId: "${W1}", toolName: "Bash", input: { command: "ls" }, engine: "deepseek", parent: "${P}" }]; state.current = { sessionId: "88888888-0000-4000-8000-0000000000ff", isNew: false, cwd: state.home }; renderSessions()`);
ok(`folded, it still says one needs you, and so does its chat: "${text("#session-list .kids-toggle")}"`, text("#session-list .kids-toggle") === "› 2 workers · 1 needs you"
  && $$("#session-list > .sess").find(r => r.textContent.includes("Plan the tidy-up")).querySelector(".dot.waiting") !== null);
ev(`const q = document.querySelector("#session-search"); q.value = "worker one"; q.dispatchEvent(new window.Event("input"))`);
ok("a search finds a worker by itself", titles().includes("Worker one") && !$("#session-list .sess-kids"));
ev(`const q = document.querySelector("#session-search"); q.value = ""; q.dispatchEvent(new window.Event("input"))`);
ev(`state.current = { sessionId: "${W2}", isNew: false, cwd: state.home }; renderSessions()`);
ok("the worker on screen is never folded away", $$("#session-list .sess.kid.on").length === 1);
ev(`state.pending = []; state.openKids = new Set(); state.sessions = state.sessions.slice(5); renderSessions()`);

// 8. The handoff in the calling chat: one quiet line (the big worker card is gone)
const CHILD = "99999999-0000-4000-8000-000000000123";
ev(`state.current = { sessionId: "${P}", cwd: state.home, title: "Plan", isNew: false, lastSeq: 0, engine: "claude" }; state.links = {}; chat.reset(); hideEmpty();
  state.pending = [{ requestId: "r-ho", sessionId: "${P}", toolName: "mcp__pocket__deepseek_task", toolUseID: "toolu_card1", input: { task: "x" }, suggestions: [] }];
  chat.event({ type: "assistant", uuid: "u-dl-1", message: { id: "m-dl-1", content: [{ type: "tool_use", id: "toolu_card1", name: "mcp__pocket__deepseek_task",
    input: { task: "## Add the CONTRIBUTORS file\\n\\nList the authors.", title: "Add the CONTRIBUTORS file" } }] } })`);
const line = () => text("#messages > .handoff");
ok(`one line, no card: "${line()}"`, $$("#messages > .handoff").length === 1 && !$("#messages .tool.dl") && !$("#messages .tool") && line() === "Sending to DeepSeek: Add the CONTRIBUTORS file · needs your OK›"
  && $("#messages .hl-st.needs") !== null);
ok("styled like the steps line: a thumb high, quiet", (w.getComputedStyle($("#messages .handoff-line")).minHeight || "") === "44px");
ev(`sheet.close(true); state.pending = []; dsRefreshHandoffs()`);
ok(`once allowed, the worker starts: "${line()}"`, line() === "Sent to DeepSeek: Add the CONTRIBUTORS file · starting›" && $("#messages .handoff").classList.contains("working"));
ev(`conn.fire("link", { parent: "${P}", child: "${CHILD}", engine: "deepseek", title: "Add the CONTRIBUTORS file", toolUseId: "toolu_card1" });
  state.liveInfo["${CHILD}"] = { sessionId: "${CHILD}", state: "running", engine: "deepseek", parent: "${P}" }`);
await sleep(150);
ok(`…then works: "${line()}"`, line() === "Sent to DeepSeek: Add the CONTRIBUTORS file · working›" && $("#messages .handoff").classList.contains("working"));
ev(`state.pending = [{ requestId: "r-c", sessionId: "${CHILD}", toolName: "Bash", input: { command: "git log" }, engine: "deepseek", parent: "${P}" }]; dsRefreshHandoffs()`);
ok(`…and needs you when it asks: "${line()}"`, line() === "Sent to DeepSeek: Add the CONTRIBUTORS file · needs you›" && $("#messages .hl-st.needs") !== null);
ev(`state.pending = []; delete state.liveInfo["${CHILD}"]; chat.event({ type: "user", uuid: "u-dl-2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card1",
  content: "DeepSeek worker: done\\nChat: ${CHILD}\\nTitle: Add the CONTRIBUTORS file\\nFolder: /root/projects/demo\\nModel: deepseek-flash · 3m 12s · about $0.031\\nChanged: 2 files\\n  M README.md\\n  ?? CONTRIBUTORS\\n---\\nI added **CONTRIBUTORS** with 3 names." }] } })`);
ok(`the report says how it went: "${line()}"`, line() === "Sent to DeepSeek: Add the CONTRIBUTORS file · done›" && !$("#messages .handoff").classList.contains("working") && ev(`state.links["${CHILD}"]?.result`) === "done");
ev(`renderTabs()`);
const done = ev(`JSON.stringify(chatAgents().find(a => a.id === "${CHILD}"))`);
ok(`its row takes the time and cost from the report, and what changed: ${done}`, /"now":"Done|"now":"2 files changed"/.test(done) && /"ms":192000/.test(done) && /"usd":0\.031/.test(done));
ev(`window.__opened = null; window.__realPage = openWorkerPage; openWorkerPage = id => { __opened = id; }`);
await tap($("#messages .handoff-line"));
ok("a tap opens that worker on the Agents tab", ev("__opened") === CHILD && ev("state.tab") === "agents");
ev(`openWorkerPage = __realPage; setTab("chat")`);
// stopped, denied, failed to start, asking Claude, a follow-up
ev(`chat.event({ type: "assistant", uuid: "u-dl-3", message: { id: "m-dl-3", content: [{ type: "tool_use", id: "toolu_card2", name: "mcp__pocket__deepseek_task", input: { task: "Do more." } }] } });
  chat.event({ type: "user", uuid: "u-dl-4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card2", is_error: true,
    content: "DeepSeek worker: stopped\\nChat: ${CHILD}\\nModel: deepseek-flash · 12s · about $0.002\\nChanged: nothing\\n---\\n" }] } });
  chat.event({ type: "assistant", uuid: "u-dl-5", message: { id: "m-dl-5", content: [{ type: "tool_use", id: "toolu_card3", name: "mcp__pocket__deepseek_task", input: { task: "Never mind.", title: "Rename things" } }] } });
  chat.event({ type: "user", uuid: "u-dl-6", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card3", is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] } });
  chat.event({ type: "assistant", uuid: "u-dl-7", message: { id: "m-dl-7", content: [{ type: "tool_use", id: "toolu_card4", name: "mcp__pocket__deepseek_task", input: { task: "Elsewhere.", title: "Build it", cwd: "/nope" } }] } });
  chat.event({ type: "user", uuid: "u-dl-8", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card4", is_error: true, content: "Folder not found: /nope" }] } });
  chat.event({ type: "assistant", uuid: "u-dl-9", message: { id: "m-dl-9", content: [{ type: "tool_use", id: "toolu_card5", name: "mcp__pocket__claude_task", input: { task: "Review it.", title: "Review the change" } }] } });
  chat.event({ type: "assistant", uuid: "u-dl-10", message: { id: "m-dl-10", content: [{ type: "tool_use", id: "toolu_card6", name: "mcp__pocket__deepseek_task", input: { task: "Fix the test.", continue_chat: "${CHILD}" } }] } })`);
const lines = $$("#messages > .handoff").map(e => e.textContent.replace(/\s+/g, " ").trim());
ok(`every handoff says what happened: ${lines.slice(1).join(" / ")}`, lines[1] === "Sent to DeepSeek: Do more. · stopped›" && lines[2] === "Not sent to DeepSeek: Rename things›"
  && lines[3] === "Couldn't send to DeepSeek: Build it›" && /^Asked Claude: Review the change · (starting|done)›$/.test(lines[4]) && /^Follow-up to DeepSeek: Add the CONTRIBUTORS file/.test(lines[5])
  && $$("#messages .hl-st.bad").length === 1);
await tap($$("#messages .handoff-line")[3]);
ok(`one that never ran shows what was asked and what came back: "${text("#sheet h2")}"`, ev("sheet.key") === "handoff" && text("#sheet h2") === "Couldn't send to DeepSeek" && /Folder not found: \/nope/.test(text("#sheet")) && /Elsewhere\./.test(text("#sheet .dl-task")));
ev("sheet.close(true)");
ok("the chat's export keeps the handoff lines", /> Sent to DeepSeek: Add the CONTRIBUTORS file · done/.test(ev("chat.toMarkdown()")));
ev(`chat.event({ type: "assistant", uuid: "u-dl-11", message: { id: "m-dl-11", content: [{ type: "text", text: "Reviewed." }] } }); chat.event({ type: "result", subtype: "success", duration_ms: 900 }); chat.event({ type: "pa_cost", usd: 0.0042 })`);
ok(`a DeepSeek turn's cost on its result line: "${text("#messages > .result-line:last-of-type")}"`, /≈ \$0\.004/.test([...$$("#messages > .result-line")].pop().textContent));

// 9. A worker's approval shows in the chat that started it, headed with the worker (#52)
const WK = "abababab-0000-4000-8000-0000000000a1";
ev(`state.links["${WK}"] = { parent: "${P}", engine: "deepseek", title: "Add README" }; state.liveInfo["${P}"] = { sessionId: "${P}", state: "running", engine: "claude", cwd: state.home };
  state.liveInfo["${WK}"] = { sessionId: "${WK}", state: "waiting", engine: "deepseek", parent: "${P}" }; state.activity["${P}"] = { phase: "tool", label: "DeepSeek is working", detail: "Add README", turnStart: Date.now() - 5000, since: Date.now(), steps: [], tokens: {} };
  __calls.length = 0; conn.fire("permission.request", { requestId: "r-wk", sessionId: "${WK}", toolName: "Bash", input: { command: "npm test", description: "Run the tests" }, engine: "deepseek", parent: "${P}", title: "Add README", suggestions: [{ type: "addRules" }] })`);
await sleep(100);
ok(`the calling chat shows it: "${text("#sheet h2")}"`, ev("sheet.key") === "perm:r-wk" && text("#sheet h2") === "DeepSeek · Add README wants to run npm test" && $("#sheet h2 code")?.textContent === "npm test"
  && $("#sheet h2 .eng-deepseek")?.textContent === "DeepSeek");
ok("a short command is in the heading, so only its description follows", !$("#sheet .perm-detail pre") && /Run the tests/.test(text("#sheet .perm-detail")));
ok(`Allow / Allow all for this worker / Deny: ${$$("#sheet .btn").map(b => b.textContent).join(" / ")}`, $$("#sheet .btn").map(b => b.textContent).join(" / ") === "Allow / Allow all for this worker / Deny");
ok("it isn't counted as another chat's (no drawer badge), and the chat says it needs approval", $("#menu-badge").hidden && /needs approval/.test(text("#chat-sub")));
ok(`the activity bar says so too: "${text("#activity")}"`, !$("#activity").hidden && $("#activity").classList.contains("approval") && /DeepSeek · Add README wants to run npm test/.test(text("#activity .a-detail")));
$('#sheet [data-a="all"]').click();
await sleep(50);
ok("Allow all for this worker answers the worker's request with allowAll", ev(`__calls.some(([t, m]) => t === "permission.reply" && m.sessionId === "${WK}" && m.requestId === "r-wk" && m.behavior === "allow" && m.allowAll === true)`) && !ev("sheet.isOpen"));
ev(`state.pending = []; conn.fire("permission.request", { requestId: "r-wk2", sessionId: "${WK}", toolName: "Bash", input: { command: "cat <<EOF > notes.md\\nlong\\nEOF" }, engine: "deepseek", parent: "${P}", title: "Add README" })`);
await sleep(50);
ok(`a longer command: "${text("#sheet h2")}", shown whole below`, text("#sheet h2") === "DeepSeek · Add README wants to run a command" && /cat <<EOF > notes\.md/.test(text("#sheet .perm-detail pre")));
$('#sheet [data-a="deny"]').click();
await sleep(50);
ok("Deny answers the worker", ev(`__calls.some(([t, m]) => t === "permission.reply" && m.requestId === "r-wk2" && m.behavior === "deny")`));
ev(`state.pending = []; conn.fire("permission.request", { requestId: "r-wq", sessionId: "${WK}", toolName: "AskUserQuestion", engine: "deepseek", parent: "${P}", title: "Add README", input: { questions: [{ question: "Which licence?", options: [{ label: "MIT" }] }] } })`);
await sleep(50);
ok(`its question, headed the same: "${text("#sheet h2")}"`, text("#sheet h2") === "DeepSeek · Add README has a question" && $$("#sheet .opt").length === 1);
ev(`sheet.close(true); state.pending = []`);
ev(`state.current = { sessionId: "cdcdcdcd-0000-4000-8000-0000000000c1", cwd: state.home, title: "Other", isNew: false, lastSeq: 0 }; conn.fire("permission.request", { requestId: "r-other", sessionId: "${WK}", toolName: "Bash", input: { command: "ls" }, engine: "deepseek", parent: "${P}", title: "Add README" })`);
await sleep(50);
ok("in another chat it doesn't pop up; the drawer badge says a chat needs you", !ev("sheet.isOpen") && !$("#menu-badge").hidden);
ev(`state.current = { sessionId: "${WK}", cwd: state.home, title: "Add README", isNew: false, lastSeq: 0, engine: "deepseek" }; updateHeader(); showNextPermission()`);
ok("opened as a chat, the worker shows its own request, headed the same", ev("sheet.key") === "perm:r-other" && /^DeepSeek · Add README wants to run ls/.test(text("#sheet h2")));
ok(`a worker opened as a chat says what it is: "${text("#chat-sub")}"`, / · DeepSeek worker/.test(text("#chat-sub")));
ev(`sheet.close(true); state.pending = []; delete state.liveInfo["${WK}"]; delete state.liveInfo["${P}"]`);

// 10. A worker's page: its own conversation, live, with Stop and Open as chat
ev(`state.current = { sessionId: "${P}", cwd: state.home, title: "Plan", isNew: false, lastSeq: 0, engine: "claude" }; chat.reset(); hideEmpty();
  state.liveInfo["${WK}"] = { sessionId: "${WK}", state: "running", engine: "deepseek", parent: "${P}", spend: 0.002, title: "Add README" };
  const real2 = conn.call; window.__real2 = real2;
  conn.call = (t, m = {}) => t === "session.history" && m.sessionId === "${WK}" ? Promise.resolve({ messages: [
      { type: "user", uuid: "b1", message: { role: "user", content: "[Pocket Agent] You're a DeepSeek worker. The Claude chat \\"Plan\\" sent you this task, and the person approved it. Work in /w.\\n\\n## Add README\\n\\nWrite it." } },
      { type: "assistant", uuid: "b2", message: { id: "n2", content: [{ type: "tool_use", id: "tb1", name: "Bash", input: { command: "ls", description: "Look around" } }] } }] })
    : t === "subscribe" && m.sessionId === "${WK}" ? Promise.resolve({ info: { ...state.liveInfo["${WK}"], seq: 7 } }) : real2(t, m);
  setTab("agents"); openWorkerPage("${WK}")`);
await until(() => $(".ag-page .task-msg"), 5000, "the worker's page");
ok(`its page: the task as a task, not as a message from you: "${text(".ag-page .task-msg summary")}"`, text("#page-title") === "Add README" && text(".ag-page .task-msg .tm-h") === "Task from “Plan”"
  && text(".ag-page .task-msg .tm-first") === "Add README" && !$(".ag-page .user-msg") && $(".ag-page .task-msg .md h2")?.textContent === "Add README");
ok("a step still running shows as running", /^Running /.test(text(".ag-page .steps .sl-t")) && $(".ag-page .steps.running") !== null);
ok(`its head: "${text(".ag-hst")}" · "${text(".ag-hmeta")}", Stop and Open as chat`, /^Working/.test(text(".ag-hst")) && /^DeepSeek · /.test(text(".ag-hmeta")) && !$('.ag-head [data-a="stop"]').hidden && $('.ag-head [data-a="open"]'));
ev(`conn.fire("ev", { sessionId: "${WK}", seq: 8, ev: { type: "assistant", uuid: "b3", message: { id: "n3", content: [{ type: "text", text: "Wrote README.md." }] } } });
  conn.fire("ev", { sessionId: "${WK}", seq: 6, ev: { type: "assistant", uuid: "b0", message: { id: "n0", content: [{ type: "text", text: "An old event." }] } } })`);
ok("live events of that worker show on its page, not in the chat", /Wrote README\.md\./.test(text(".ag-page .ag-chat")) && !/An old event/.test(text(".ag-page")) && !/Wrote README/.test(text("#messages")));
ok("its page has no edit or retry (that's for the chat itself)", !$(".ag-page [data-a='edit']") && !$(".ag-page [data-a='retry']"));
$('.ag-head [data-a="stop"]').click();
await sleep(50);
ok("Stop stops that worker", ev(`__calls.some(([t, m]) => t === "interrupt" && m.sessionId === "${WK}")`));
ev(`window.__opened = null; window.__realOpen = openSession; openSession = id => { __opened = id; state.current = { sessionId: id, cwd: state.home, title: "Add README", isNew: false, lastSeq: 0 }; return Promise.resolve(); }`);
$('.ag-head [data-a="open"]').click();
await sleep(50);
ok("Open as chat opens the worker as a chat", ev("__opened") === WK && $("#page").hidden && ev(`__calls.some(([t, m]) => t === "unsubscribe" && m.sessionId === "${WK}")`));
ev(`openSession = id => { __opened = id; state.current = { sessionId: id, cwd: state.home, title: "Plan", isNew: false, lastSeq: 0 }; return Promise.resolve(); }; openWorkerPage = id => { window.__page = id; }`);
ok("Android back from there returns to the chat that started it, on its Agents tab", w.paBack() === true && ev("__opened") === P);
await sleep(50);
ok("…with that worker's page open again", ev("state.tab") === "agents" && ev("window.__page") === WK);
ev(`openSession = __realOpen; openWorkerPage = __realPage; conn.call = __real2; setTab("chat"); delete state.liveInfo["${WK}"]`);

console.log(errors.length ? "\nPAGE ERRORS:\n" + errors.join("\n") : "\nno page errors");
if (errors.length) fails++;
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
w.close(); process.exit(fails ? 1 : 0);
