// A reply's tool steps as one quiet line in the chat ("Ran 2 commands, read 3 files ›"), a timeline sheet of
// the steps, and a page per step with its input and output. Settings → Appearance can show the cards instead.
const STEP_KIND = { Bash: "cmd", BashOutput: "cmd", KillShell: "cmd", Read: "read", Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Glob: "search", Grep: "search", LSP: "search", WebFetch: "web", WebSearch: "web", Task: "agent", Agent: "agent", TodoWrite: "todo", Skill: "skill" };
const STEP_DONE = { cmd: ["ran a command", "ran # commands"], read: ["read a file", "read # files"], edit: ["edited a file", "edited # files"],
  search: ["searched once", "searched # times"], web: ["looked something up", "looked up # things"], agent: ["ran a subagent", "ran # subagents"],
  todo: ["updated the to-dos", "updated the to-dos"], skill: ["used a skill", "used # skills"], tool: ["used a tool", "used # tools"] };
const STEP_NOW = { cmd: "Running", read: "Reading", edit: "Editing", search: "Searching", web: "Looking up", agent: "Running a subagent:", todo: "Updating the to-dos", skill: "Using", tool: "Using" };
const STEP_PAST = { cmd: "Ran", read: "Read", edit: "Edited", search: "Searched", web: "Looked up", agent: "Subagent", todo: "Updated the to-dos", skill: "Used", tool: "Used" };
const stepKind = c => STEP_KIND[c.name] || "tool";

/** What a step works on, short: a file name, a command's description, a search pattern. */
function stepShort(c) {
  const i = c.input || {}, k = stepKind(c);
  if (k === "read" || k === "edit") return baseName(i.file_path || i.notebook_path || "");
  if (k === "todo") return "";
  if (k === "tool") return prettyToolName(c.name);
  const s = toolSummary(c.name, i) || "";
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
function stepsSummary(cards) {
  const now = cards.filter(c => c.status === "run").pop();
  if (now) { const k = stepKind(now); return `${STEP_NOW[k]} ${stepShort(now)}`.trim() + "…"; }
  const n = {};
  for (const c of cards) { const k = stepKind(c); n[k] = (n[k] || 0) + 1; }
  const s = Object.entries(n).map(([k, x]) => (x === 1 ? STEP_DONE[k][0] : STEP_DONE[k][1].replace("#", x))).join(", ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
const stepVerb = c => (c.status === "run" ? STEP_NOW[stepKind(c)] : c.name === "Write" ? "Wrote" : STEP_PAST[stepKind(c)]);

function openSteps(g) {
  sheet.open(`<div id="steps-sheet"></div>`, { key: "steps" });
  sheet.group = g;
  drawSteps(g);
}
function drawSteps(g) {
  const b = $("#steps-sheet"); if (!b) return;
  b.innerHTML = `<h2></h2><ol class="step-tl"></ol>`;
  b.querySelector("h2").textContent = g.querySelector(".sl-t").textContent;
  const ol = b.querySelector("ol");
  for (const el of g.querySelector(".steps-list").children) {
    const c = el._card;
    const li = h(`<li><button class="step-row">${icon(c ? TOOL_ICON[c.name] || (c.name.startsWith("mcp__") ? "bolt" : "terminal") : "brain")}<span class="sr-t"><b></b> <span></span></span><span class="sr-st">${
      c?.status === "run" ? '<span class="spark"></span>' : c?.status === "err" ? icon("x") : ""}</span></button></li>`);
    li.querySelector("b").textContent = c ? stepVerb(c) : "Thought";
    li.querySelector(".sr-t span").textContent = c ? stepShort(c) : "";
    li.querySelector("button").onclick = () => { sheet.close(true); openStep(el, g); };
    ol.append(li);
  }
}

/** A step's own page: the card itself moves in (so a running step keeps updating) and goes back on leaving. */
function openStep(el, fromGroup) {
  const c = el._card, ph = document.createComment("step"), wasOpen = el.open;
  page.open(c ? prettyToolName(c.name) : "Thought", body => {
    if (!ph.parentNode) el.replaceWith(ph);
    const st = c ? (c.status === "run" ? "In progress" : c.status === "err" ? "Failed" : c.status === "ok" ? "Completed" : "") : "";
    body.innerHTML = st ? `<div class="step-st ${c.status}">${st}</div>` : "";
    el.classList.add("in-page"); el.open = true;
    body.append(el);
    decorateBlocks(el);
  }, "", how => { el.classList.remove("in-page"); el.open = wasOpen; ph.replaceWith(el); if (how === "back" && fromGroup) openSteps(fromGroup); });   // back returns to the timeline
}
/** Copy buttons on every block, and Prettify / Show raw on JSON output. */
function decorateBlocks(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.dataset.dec || pre.querySelector(".code-head")) continue;
    pre.dataset.dec = "1";
    const code = pre.querySelector("code") || pre, raw = code.textContent;
    const bar = h(`<div class="blk-btns"><button class="chip sm" data-a="copy">Copy</button></div>`);
    bar.querySelector('[data-a="copy"]').onclick = () => copyText(code.textContent);
    let json = null;
    if (pre.closest(".tout") && /^\s*[[{]/.test(raw)) try { json = JSON.parse(raw); } catch {}
    if (json && typeof json === "object") {
      const t = h(`<button class="chip sm" data-a="pretty">Prettify</button>`);
      t.onclick = () => { const pretty = t.textContent === "Prettify"; code.textContent = pretty ? JSON.stringify(json, null, 2) : raw; t.textContent = pretty ? "Show raw" : "Prettify"; };
      bar.prepend(t);
    }
    pre.classList.add("has-btns");
    pre.prepend(bar);
  }
}
