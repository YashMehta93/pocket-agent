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
ok("the chip sits before the mode chip, the same small chip", $("#chip-engine").nextElementSibling === $("#chip-mode") && $("#chip-engine").classList.contains("chip") && w.getComputedStyle($("#composer .chips")).flexWrap === "wrap");
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
ok("the category sits right after Claude and connection", $('[data-sec="deepseek"]')?.previousElementSibling?.dataset.sec === "claude"); ev("page.close()");
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

// 6. The links bar
const P = "44444444-0000-4000-8000-0000000000cc", C = "55555555-0000-4000-8000-0000000000dd";
ev(`state.current = { sessionId: "${P}", cwd: state.home, title: "Plan the tidy-up", isNew: false, lastSeq: 0, engine: "claude" }; updateHeader()`);
ok("no workers, no bar", $("#links-bar").hidden);
ev(`conn.fire("link", { parent: "${P}", child: "${C}", engine: "deepseek", title: "T1", toolUseId: "toolu_link1" })`);
await sleep(150);
ok(`a worker shows as a row: "${text("#links-bar")}"`, !$("#links-bar").hidden && $$("#links-bar .lk-row").length === 1 && /^DeepSeek · T1 · done/.test(text("#links-bar .lk-row")));
ev(`state.liveInfo["${C}"] = { sessionId: "${C}", state: "running", engine: "deepseek", parent: "${P}" }; conn.fire("state", { sessionId: "${C}", state: "running", info: state.liveInfo["${C}"] })`);
await sleep(150);
ok("…working while it runs", /DeepSeek · T1 · working/.test(text("#links-bar")) && $("#links-bar .spark") !== null);
ev(`state.pending = [{ requestId: "r-w", sessionId: "${C}", toolName: "Bash", input: { command: "ls" } }]; conn.fire("permission.request", { requestId: "r-w", sessionId: "${C}", toolName: "Bash" })`);
await sleep(150);
ok("…and needs you when it asks", /DeepSeek · T1 · needs you/.test(text("#links-bar")) && $("#links-bar .lk-st.needs-you") !== null);
ok("each row is a thumb high", (w.getComputedStyle($("#links-bar .lk-row")).minHeight || "") === "44px");
ev(`window.__opened = null; window.__realOpen = openSession; openSession = id => { __opened = id; }`);
$("#links-bar .lk-row").click();
ok("tapping it opens the worker's chat", ev("__opened") === C);
for (const [i, t] of ["T2", "T3", "T4"].entries()) ev(`conn.fire("link", { parent: "${P}", child: "66666666-0000-4000-8000-00000000000${i}", engine: "deepseek", title: "${t}", toolUseId: "toolu_x${i}" })`);
await sleep(150);
ok(`kept short: the one at work and "+N more" (${text("#links-bar")})`, $$("#links-bar .lk-row").length === 2 && /needs you/.test(text("#links-bar .lk-row")) && /\+3 more worker chats/.test(text("#links-bar")));
$("#links-bar [data-more]").click();
ok("…which lists them all", ev("sheet.key") === "links" && $$("#sheet .lk-row").length === 4); ev("sheet.close(true)");
ev(`state.current = { sessionId: "${C}", cwd: state.home, title: "T1", isNew: false, lastSeq: 0, engine: "deepseek" };
  state.sessions = [{ sessionId: "${P}", title: "Plan the tidy-up", cwd: state.home, lastModified: Date.now() }, ...state.sessions]; updateHeader()`);
ok(`in the worker, the bar leads back: "${text("#links-bar")}"`, $$("#links-bar .lk-row").length === 1 && /^From: Plan the tidy-up/.test(text("#links-bar")));
$("#links-bar .lk-row").click();
ok("…to the chat that started it", ev("__opened") === P);
ev(`openSession = __realOpen; state.pending = []; delete state.liveInfo["${C}"]; state.sessions = state.sessions.filter(s => s.sessionId !== "${P}")`);

// 7. The drawer
ev(`state.sessions = [{ sessionId: "77777777-0000-4000-8000-0000000000ee", title: "Worker W", cwd: state.home + "/projects/demo", lastModified: Date.now(), engine: "deepseek", parent: "x" },
  { sessionId: "88888888-0000-4000-8000-0000000000ff", title: "A DeepSeek chat", cwd: state.home, lastModified: Date.now(), engine: "deepseek" }, ...state.sessions]; renderSessions()`);
const metas = $$("#session-list .sess .meta").map(m => m.textContent);
ok(`the drawer marks workers and DeepSeek chats: ${metas.slice(0, 2).join(" / ")}`, /· DeepSeek worker/.test(metas[0]) && /· DeepSeek$/.test(metas[1]));
ev(`state.sessions = state.sessions.slice(2); renderSessions()`);

// 8. The worker's card in the calling chat
const CHILD = "99999999-0000-4000-8000-000000000123";
ev(`state.current = { sessionId: "${P}", cwd: state.home, title: "Plan", isNew: false, lastSeq: 0, engine: "claude" }; state.links = {}; chat.reset(); hideEmpty();
  chat.event({ type: "assistant", uuid: "u-dl-1", message: { id: "m-dl-1", content: [{ type: "tool_use", id: "toolu_card1", name: "mcp__pocket__deepseek_task",
    input: { task: "## Add the CONTRIBUTORS file\\n\\nList the authors.", title: "Add the CONTRIBUTORS file" } }] } })`);
const card = $("#messages > .tool.dl");
ok("the worker's card stands on its own in the chat, open", card && card.open && !card.closest(".steps") && text("#messages .tool.dl .tn") === "DeepSeek worker" && text("#messages .tool.dl .ts") === "Add the CONTRIBUTORS file");
ok("before the link: no Open link yet", $("#messages .tool.dl .dl-open").hidden);
ev(`conn.fire("link", { parent: "${P}", child: "${CHILD}", engine: "deepseek", title: "Add the CONTRIBUTORS file", toolUseId: "toolu_card1" });
  state.liveInfo["${CHILD}"] = { sessionId: "${CHILD}", state: "running", engine: "deepseek", parent: "${P}" }`);
await sleep(150);
ok(`once the worker starts, the card links to it: "${text("#messages .tool.dl .dl-head")}"`, !$("#messages .tool.dl .dl-open").hidden && /Working…/.test(text("#messages .tool.dl .dl-st")));
ev(`delete state.liveInfo["${CHILD}"]; chat.event({ type: "user", uuid: "u-dl-2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card1",
  content: "DeepSeek worker: done\\nChat: ${CHILD}\\nTitle: Add the CONTRIBUTORS file\\nFolder: /root/projects/demo\\nModel: deepseek-flash · 3m 12s · about $0.031\\nChanged: 2 files\\n  M README.md\\n  ?? CONTRIBUTORS\\n---\\nI added **CONTRIBUTORS** with 3 names." }] } })`);
ok(`the report: "${text("#messages .tool.dl .dl-st")}"`, text("#messages .tool.dl .dl-st") === "Done · 2 files changed · 3m 12s · about $0.031" && $("#messages .tool.dl .st.ok") !== null);
ok("the report shows the changed files and the worker's last message", /M README\.md/.test(text("#messages .tool.dl .dl-files")) && $("#messages .tool.dl .tout .md strong")?.textContent === "CONTRIBUTORS");
ok("the links bar learns how it ended", ev(`state.links["${CHILD}"]?.result`) === "done");
ev(`state.sessions = [{ sessionId: "${CHILD}", title: "Add the CONTRIBUTORS file", cwd: state.home, lastModified: Date.now(), engine: "deepseek", parent: "${P}" }, ...state.sessions]; state.links["${CHILD}"] = { result: "stopped" }; renderLinksBar()`);
ok("…even when only the chat list knows the worker's parent", /Add the CONTRIBUTORS file · stopped/.test(text("#links-bar")));
ev(`state.sessions = state.sessions.slice(1); state.links["${CHILD}"] = { parent: "${P}", result: "done" }`);
ev(`state.links = {}; window.__opened = null; window.__realOpen = openSession; openSession = id => { __opened = id; }`);
$("#messages .tool.dl .dl-open").click();
ok("Open chat › opens the worker from the report's Chat: line", ev("__opened") === CHILD);
ev(`openSession = __realOpen`);
ev(`chat.event({ type: "assistant", uuid: "u-dl-3", message: { id: "m-dl-3", content: [{ type: "tool_use", id: "toolu_card2", name: "mcp__pocket__deepseek_task", input: { task: "Do more." } }] } });
  chat.event({ type: "user", uuid: "u-dl-4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card2", is_error: true,
    content: "DeepSeek worker: stopped\\nChat: ${CHILD}\\nModel: deepseek-flash · 12s · about $0.002\\nChanged: nothing\\n---\\n" }] } })`);
ok(`a stopped worker: "${text("#messages .tool.dl:last-of-type .dl-st")}"`, /^Stopped · no files changed · 12s/.test([...$$("#messages .tool.dl")].pop().querySelector(".dl-st").textContent));
ev(`chat.event({ type: "assistant", uuid: "u-dl-5", message: { id: "m-dl-5", content: [{ type: "text", text: "Reviewed." }] } }); chat.event({ type: "result", subtype: "success", duration_ms: 900 }); chat.event({ type: "pa_cost", usd: 0.0042 })`);
ok(`a DeepSeek turn's cost on its result line: "${text("#messages > .result-line:last-of-type")}"`, /≈ \$0\.004/.test([...$$("#messages > .result-line")].pop().textContent));

console.log(errors.length ? "\nPAGE ERRORS:\n" + errors.join("\n") : "\nno page errors");
if (errors.length) fails++;
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
w.close(); process.exit(fails ? 1 : 0);
