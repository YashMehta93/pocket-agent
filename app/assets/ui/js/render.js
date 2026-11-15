// render.js — turns Claude Code session messages (history + live SDK events) into the chat view.
"use strict";

marked.setOptions({ gfm: true, breaks: false });
function mdToHtml(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ""), { ADD_ATTR: ["target"] });
  return html;
}
function enhanceMd(el) {
  el.querySelectorAll("pre > code").forEach(code => {
    const pre = code.parentElement;
    if (pre.querySelector(".code-head")) return;
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || "";
    try {
      if (lang && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
      else if (code.textContent.length < 20000) hljs.highlightElement(code);
    } catch {}
    const head = h(`<div class="code-head"><span>${esc(lang || "text")}</span><button>Copy</button></div>`);
    head.querySelector("button").onclick = () => copyText(code.textContent);
    pre.prepend(head);
  });
  el.querySelectorAll("a[href]").forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
}
function setMd(el, text) { el.innerHTML = mdToHtml(text); enhanceMd(el); }

const TOOL_ICON = { Bash: "terminal", BashOutput: "terminal", KillShell: "terminal", Read: "eye", Write: "file", Edit: "pencil", MultiEdit: "pencil",
  NotebookEdit: "pencil", Glob: "search", Grep: "search", WebFetch: "globe", WebSearch: "globe", TodoWrite: "list", Task: "bot", Agent: "bot",
  ExitPlanMode: "plan", AskUserQuestion: "question", Skill: "bolt", LSP: "search", mcp__pocket__deepseek_task: "bot", mcp__pocket__claude_task: "bot" };
/** Semantic colour of a tool: read (blue), edit (green), run (yellow). */
const TOOL_KIND = { Read: "read", Glob: "read", Grep: "read", WebFetch: "read", WebSearch: "read", LSP: "read",
  Write: "edit", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Bash: "run", BashOutput: "run", KillShell: "run", Task: "run", Agent: "run", Skill: "run" };
const EXT_LANG = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", py: "python", java: "java",
  kt: "kotlin", sh: "bash", bash: "bash", json: "json", md: "markdown", html: "xml", xml: "xml", css: "css", go: "go", rs: "rust", rb: "ruby", c: "c", h: "c",
  cpp: "cpp", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql", php: "php", swift: "swift", gradle: "groovy" };
const langOf = p => EXT_LANG[(p || "").split(".").pop().toLowerCase()] || "";

function toolSummary(name, inp = {}) {
  switch (name) {
    case "Bash": return inp.description || inp.command || "";
    case "Read": case "Write": case "Edit": case "MultiEdit": return shortPath(inp.file_path);
    case "NotebookEdit": return shortPath(inp.notebook_path);
    case "Glob": case "Grep": return inp.pattern + (inp.path ? "  in " + shortPath(inp.path) : "");
    case "WebFetch": return inp.url; case "WebSearch": return inp.query;
    case "Task": case "Agent": return inp.description || inp.subagent_type || "";
    case "TodoWrite": return `${(inp.todos || []).length} items`;
    case "Skill": return inp.skill || inp.command || "";
    case "AskUserQuestion": return (inp.questions || [])[0]?.question || "";
    case "ExitPlanMode": return "Proposed plan";
    case "mcp__pocket__deepseek_task": case "mcp__pocket__claude_task": return inp.title || (typeof dsFirstLine === "function" ? dsFirstLine(inp.task) : "");
    default: { const v = Object.values(inp).find(x => typeof x === "string"); return v ? v.slice(0, 120) : ""; }
  }
}
function prettyToolName(name) {
  if (name === "mcp__pocket__deepseek_task") return "DeepSeek worker";
  if (name === "mcp__pocket__claude_task") return "Claude worker";
  if (name.startsWith("mcp__")) { const p = name.split("__"); return `${p[1]}·${p.slice(2).join("__")}`; }
  return name === "Task" || name === "Agent" ? "Subagent" : name;
}

function codeBlock(text, lang = "", wrap = false) {
  const pre = document.createElement("pre"); if (wrap) pre.className = "wrap";
  const code = document.createElement("code"); code.textContent = text;
  if (lang && hljs.getLanguage(lang) && text.length < 60000) { try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch {} }
  pre.append(code); return pre;
}
function diffLines(oldS = "", newS = "") {
  const a = oldS.split("\n"), b = newS.split("\n");
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const out = [];
  for (let i = Math.max(0, s - 2); i < s; i++) out.push(" " + a[i]);
  for (let i = s; i < a.length - e; i++) out.push("-" + a[i]);
  for (let i = s; i < b.length - e; i++) out.push("+" + b[i]);
  for (let i = a.length - e; i < Math.min(a.length, a.length - e + 2); i++) out.push(" " + a[i]);
  return out;
}
function diffView(lines) {
  const d = document.createElement("div"); d.className = "diff";
  let add = 0, del = 0;
  for (const l of lines) {
    const row = document.createElement("div");
    const c = l[0];
    row.className = c === "+" ? "a" : c === "-" ? "d" : c === "@" ? "h" : "";
    if (c === "+") add++; if (c === "-") del++;
    row.textContent = l; d.append(row);
  }
  return { el: d, add, del };
}
function todoList(todos = []) {
  const ul = document.createElement("ul"); ul.className = "todo-list";
  for (const t of todos) {
    const li = h(`<li class="${esc(t.status)}">${icon(t.status === "completed" ? "ccheck" : t.status === "in_progress" ? "cdot" : "circle")}<span>${esc(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)}</span></li>`);
    ul.append(li);
  }
  return ul;
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c.type === "text" ? c.text : c.type === "image" ? "[image]" : "").join("\n");
  return content == null ? "" : JSON.stringify(content, null, 2);
}
function stripReminders(t) { return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(); }

class ChatView {
  /** opts.embedded: inside an agent's page (agents.js), so it leaves the chat's to-do bar, status line and scrolling
   *  alone, and offers no edit or retry; opts.scroller() is then the element that scrolls it. */
  constructor(root, opts = {}) { this.root = root; this.opts = opts; this.stick = true; this.reset(); }
  get embedded() { return !!this.opts.embedded; }
  scrollIfPinned() { if (!this.embedded) return scrollIfPinned(); const el = this.opts.scroller?.(); if (el && this.stick) el.scrollTop = el.scrollHeight; }
  reset() {
    this.root.innerHTML = "";
    this.tools = new Map();      // tool_use_id -> card
    this.ghosts = new Map();     // `${parent || ""}:${msgId}:${index}` -> {el, md?, kind, text}
    this.streamTools = new Map(); // the same key -> {id, json} for tool calls being streamed
    this.curMsgByParent = new Map(); // parent_tool_use_id || "" -> the message id streaming there now
    this.order = [];             // message uuids in order (for fork/edit)
    this.userTexts = new Map();  // uuid -> text
    this.rendered = new Set();   // uuids already rendered
    this.renderedBlocks = new Set(); // `${msgId}:${blockKey}` already rendered
    this.doneMsgs = new Set();    // message ids drawn whole: a replayed stream for one adds no second ghost
    this.todos = null;
    this.lastText = "";
    this.turnStart = null;
    if (!this.embedded) updateTodoBar(null);
  }
  get empty() { return !this.root.children.length; }

  container(parentId) {
    if (parentId) { const card = this.tools.get(parentId); if (card) return card.sub || (card.sub = this.makeSub(card)); }
    return this.root;
  }
  makeSub(card) { const d = document.createElement("div"); d.className = "subagent"; card.body.append(d); return d; }

  // ───── history (SessionMessage[]) ─────
  /** live: the chat is still at work (an agent's page), so its unfinished steps keep running */
  loadHistory(messages, { live = false } = {}) {
    this.loadingHistory = true;   // history appears at once; only live messages animate in
    for (const m of messages) {
      if (m.uuid) this.order.push(m.uuid);
      if (m.type === "assistant") this.assistant(m.message, m.parent_tool_use_id, m.uuid, true);
      else if (m.type === "user") this.user(m.message, m.parent_tool_use_id, m.uuid, true);
      else if (m.type === "system") this.systemHistory(m);
    }
    this.finishGhosts();
    // a step with no result yet: still running in a live chat, cut off in an old one
    for (const card of this.tools.values()) if (live ? card.status === "done" : card.status === "run") this.setStatus(card, live ? "run" : "unknown");
    this.loadingHistory = false;
    this.fresh = false;
  }
  systemHistory(m) {
    const msg = m.message || {};
    if (msg.subtype === "compact_boundary" || m.subtype === "compact_boundary") this.divider("Conversation compacted");
  }

  // ───── live events ─────
  event(ev) {
    switch (ev.type) {
      case "pa_user": this.userBubble(ev.text, ev.images || [], ev.uuid); this.turnStart = Date.now(); break;
      case "stream_event": this.stream(ev); break;
      case "assistant": if (ev.uuid) this.order.push(ev.uuid); this.assistant(ev.message, ev.parent_tool_use_id, ev.uuid, false); break;
      case "user": if (ev.uuid) this.order.push(ev.uuid); this.user(ev.message, ev.parent_tool_use_id, ev.uuid, false, ev.tool_use_result); break;
      case "result": this.finishGhosts(); this.resultLine(ev); break;
      case "system": this.system(ev); break;
      case "pa_error": this.note("Error: " + ev.message, true); break;
      case "pa_cost": this.costNote(ev.usd); break;
      case "tool_progress": { const c = this.tools.get(ev.tool_use_id); if (c && ev.elapsed_time_seconds) c.summaryEl.title = `${Math.round(ev.elapsed_time_seconds)}s`; break; }
    }
  }
  system(ev) {
    if (ev.subtype === "compact_boundary") this.divider("Conversation compacted");
    else if (this.embedded) return;   // the status line and toasts belong to the chat on screen
    else if (ev.subtype === "local_command_output" && ev.content) this.note(ev.content);
    else if (ev.subtype === "informational" && ev.content) this.note(ev.content);
    else if (ev.subtype === "notification" && ev.text) toast(ev.text);
    else if (ev.subtype === "api_retry") setStatus(`Retrying (${ev.attempt || ""})…`);
    else if (ev.subtype === "status") setStatus(ev.status === "compacting" ? "Compacting conversation…" : null);
    else if (ev.subtype === "model_refusal_fallback") this.note(`Switched to ${ev.fallback_model || "fallback model"} for this reply.`);
  }

  stream(ev) {
    const e = ev.event; if (!e) return;
    const parentId = ev.parent_tool_use_id || null;
    const pkey = parentId || "";
    if (e.type === "message_start") { this.curMsgByParent.set(pkey, e.message?.id); return; }
    // Each parent (the main chat, each subagent) has its own message streaming. Subagents interleave with the
    // main reply, so a single "current message" would key their blocks under whichever message started last.
    const msgId = this.curMsgByParent.get(pkey);
    if (msgId == null) return;   // a block whose message start we missed: its final message draws it
    const key = `${pkey}:${msgId}:${e.index}`;
    if (e.type === "content_block_start") {
      if (this.doneMsgs.has(msgId)) return;   // the whole message is already drawn (the transcript overlapped the replay)
      const b = e.content_block;
      if (b.type === "text" || b.type === "thinking") {
        if (b.type === "text") {
          const el = h(`<div class="md ghost caret"></div>`);
          this.container(parentId).append(el);
          this.ghosts.set(key, { el, kind: "text", text: "" });
        } else {
          const md = this.thoughtSlot(parentId, true);
          this.ghosts.set(key, { el: md.closest(".thinking"), md, kind: "thinking", text: "" });
        }
        this.scrollIfPinned();
      } else if (b.type === "tool_use") {
        if (!this.tools.has(b.id)) this.toolCard(b.id, b.name, {}, parentId, true);
        (this.streamTools ||= new Map()).set(key, { id: b.id, json: "" });
      }
    } else if (e.type === "content_block_delta") {
      const d = e.delta;
      if (d.type === "input_json_delta") { this.streamToolInput(key, d.partial_json || ""); return; }
      const g = this.ghosts.get(key); if (!g) return;
      if (d.type === "text_delta") g.text += d.text; else if (d.type === "thinking_delta") g.text += d.thinking; else return;
      this.scheduleGhost(g);
    } else if (e.type === "content_block_stop") {
      const g = this.ghosts.get(key); if (g) { g.el.classList.remove("caret"); this.paintGhost(g); }
    }
  }
  /** Show the command / file path in a tool card while Claude is still writing the tool call. */
  streamToolInput(key, chunk) {
    const st = this.streamTools?.get(key); if (!st) return;
    st.json += chunk;
    const card = this.tools.get(st.id); if (!card || Object.keys(card.input || {}).length) return;
    const field = f => { const m = st.json.match(new RegExp(`"${f}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`)); if (!m) return ""; try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch { return m[1]; } };
    if (card.handoff) { const t = field("title") || field("task").split("\n").map(l => l.trim()).find(Boolean) || ""; if (t && t !== card.streamTitle) { card.streamTitle = t.slice(0, 80); handoffLine(card); } return; }
    let hint = card.name === "Bash" ? field("command") : shortPath(field("file_path")) || field("pattern") || field("description") || field("url") || field("query");
    if (card.name === "Write") hint = `${shortPath(field("file_path"))} · ${(st.json.match(/\\n/g) || []).length + 1} lines so far`;
    if (hint) card.summaryEl.textContent = hint;
  }
  scheduleGhost(g) { if (g.t) return; g.t = setTimeout(() => { g.t = null; this.paintGhost(g); this.scrollIfPinned(); }, 70); }
  paintGhost(g) {
    if (g.kind === "text") setMd(g.el, g.text);
    else { if (g.text.trim()) delete g.md.dataset.live; setMd(g.md, g.text || "…"); }
  }
  finishGhosts() {
    const heads = new Set();
    for (const g of this.ghosts.values()) {
      clearTimeout(g.t);
      g.el.classList.remove("caret");
      if (g.kind !== "thinking") continue;
      if (g.text.trim()) { delete g.md.dataset.live; if (g.md.isConnected) setMd(g.md, g.text); }
      if (g.md.isConnected) heads.add(g.el);
    }
    this.ghosts.clear();
    for (const head of heads) {
      // a thought that never got a word is no entry (a withheld or redacted block with no summary)
      head.querySelectorAll(".th-body > .md[data-live]").forEach(md => { if (!md.textContent.trim() || md.textContent.trim() === "…") md.remove(); });
      if (!head.querySelector(".th-body > .md")) head.remove(); else this.endThought(head);
    }
  }
  /** The live placeholder for exactly this block, or null: never another block's placeholder. */
  takeGhost(kind, parentId, msgId, index) {
    if (msgId == null) return null;
    const exact = `${parentId || ""}:${msgId}:${index}`;
    let key = this.ghosts.get(exact)?.kind === kind ? exact : null;
    // the same block keyed under another parent (a reply replayed with a different parent) is still its own
    if (!key) for (const [k, g] of this.ghosts) if (g.kind === kind && k.endsWith(`:${msgId}:${index}`)) { key = k; break; }
    if (!key) return null;
    const g = this.ghosts.get(key);
    clearTimeout(g.t); this.ghosts.delete(key); return g;
  }

  // ───── assistant content ─────
  assistant(msg, parentId, uuid, history) {
    if (!msg) return;
    if (msg.id) this.doneMsgs.add(msg.id);   // a later stream_event for this message (a replay overlap) is history
    if (!Array.isArray(msg.content)) return;
    const parent = this.container(parentId);
    msg.content.forEach((b, i) => {
      const bkey = `${msg.id}:${b.type}:${b.id || i}:${(b.text || b.thinking || "").length}`;
      if (this.renderedBlocks.has(bkey)) return;
      this.renderedBlocks.add(bkey);
      this.fresh = true;
      if (b.type === "text") {
        if (!b.text?.trim()) return;
        const g = !history && this.takeGhost("text", parentId, msg.id, i);
        const el = g ? g.el : h(`<div class="md"></div>`);
        el.classList.remove("ghost", "caret");
        setMd(el, b.text);
        if (!g) parent.append(el);
        if (!parentId) this.lastText = b.text;
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        const text = b.thinking || "";
        const g = !history && this.takeGhost("thinking", parentId, msg.id, i);
        if (!text) {
          // Withheld (or redacted) thinking: no entry of its own. Its live slot, when there is one,
          // stays empty for the summary that follows in this message.
          if (g) g.el.classList.remove("caret");
          return;
        }
        const md = g ? g.md : this.thoughtSlot(parentId, false);
        delete md.dataset.live;
        setMd(md, text);
        this.endThought(md.closest(".thinking"));
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
        const card = this.tools.get(b.id);
        if (card) { card.input = b.input || {}; this.fillToolInput(card); }
        else this.toolCard(b.id, b.name, b.input || {}, parentId, !history);
      }
    });
    this.scrollIfPinned();
  }

  // ───── user content (prompts + tool results) ─────
  user(msg, parentId, uuid, history, structured) {
    if (!msg) return;
    const content = msg.content;
    if (typeof content === "string") { if (history && !parentId) this.userText(content, [], uuid); return; }
    if (!Array.isArray(content)) return;
    const texts = [], images = [];
    for (const b of content) {
      if (b.type === "tool_result") this.toolResult(b, structured);
      else if (b.type === "text") texts.push(b.text);
      else if (b.type === "image" && b.source?.data) images.push({ mediaType: b.source.media_type, data: b.source.data });
    }
    if (history && !parentId && (texts.length || images.length)) this.userText(texts.join("\n"), images, uuid);
  }
  userText(raw, images, uuid) {
    const text = stripReminders(raw || "");
    if (!text && !images.length) return;
    const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
    if (cmd) { const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || ""; return this.userBubble(`${cmd[1].trim()} ${args.trim()}`.trim(), [], uuid, true); }
    const out = text.match(/<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/);
    if (out) { if (out[1].trim()) this.note(out[1].trim()); return; }
    if (/^\[Request interrupted/.test(text)) return this.divider("Interrupted");
    if (text.startsWith("<") && /^<[\w-]+>/.test(text) && !images.length) return; // other internal markers
    if (/^Caveat: The messages below/.test(text)) return;
    this.userBubble(text, images, uuid);
  }
  userBubble(text, images = [], uuid, isCmd) {
    if (uuid && this.rendered.has(uuid)) return;
    if (uuid) { this.rendered.add(uuid); this.userTexts.set(uuid, text); }
    this.fresh = true;
    const task = workerTask(text);
    if (task && !images.length) return this.taskBlock(task);
    const wrap = h(`<div class="user-msg-wrap"><div class="user-msg"><div><div class="imgs"></div><div class="bubble ${isCmd ? "cmd-chip" : ""}"></div></div></div>
      <div class="msg-actions" hidden><button class="icon-btn sm" data-a="copy" data-icon="copy" aria-label="Copy"></button>${uuid ? `<button class="icon-btn sm" data-a="edit" data-icon="edit" aria-label="Edit"></button>` : ""}</div></div>`);
    wrap.querySelector(".bubble").textContent = text;
    const imgs = wrap.querySelector(".imgs");
    for (const im of images) { const i = document.createElement("img"); i.src = `data:${im.mediaType};base64,${im.data}`; imgs.append(i); }
    if (!images.length) imgs.remove();
    const acts = wrap.querySelector(".msg-actions");
    wrap.querySelector(".bubble").onclick = () => { acts.hidden = !acts.hidden; };
    acts.querySelector('[data-a="copy"]').onclick = () => copyText(text);
    const ed = acts.querySelector('[data-a="edit"]'); if (ed) { if (this.embedded) ed.remove(); else ed.onclick = () => editMessage(uuid, text); }
    this.root.append(wrap);
    if (this.embedded) this.scrollIfPinned(); else scrollToBottom();
  }
  /** "Task from “Plan the tidy-up”" with its first line; the whole task (Markdown) opens with a tap. */
  taskBlock({ from, task, followUp }) {
    const el = h(`<details class="task-msg"><summary><span class="tm-h"></span><span class="tm-first"></span></summary><div class="md"></div></details>`);
    el.querySelector(".tm-h").textContent = (followUp ? "Follow-up from " : "Task from ") + (from ? "“" + from + "”" : "the calling chat");
    el.querySelector(".tm-first").textContent = String(task).split("\n").map(l => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) || "";
    setMd(el.querySelector(".md"), task);
    this.root.append(el);
    this.scrollIfPinned();
  }

  // ───── tool cards ─────
  toolCard(id, name, input, parentId, live) {
    if (name.startsWith("mcp__pocket__") && typeof handoffLine === "function") return this.handoffCard(id, name, input, parentId, live);
    const el = h(`<details class="tool"><summary><span class="ti">${icon(TOOL_ICON[name] || (name.startsWith("mcp__") ? "bolt" : "terminal"))}</span>
      <span class="tn"></span><span class="ts"></span><span class="st ${live ? "spin" : ""}"></span></summary><div class="tb"></div></details>`);
    el.querySelector(".tn").textContent = prettyToolName(name);
    el.dataset.kind = TOOL_KIND[name] || (name.startsWith("mcp__") ? "run" : "other");  // colours the tag (css: .tool[data-kind])
    const card = { id, name, input, el, body: el.querySelector(".tb"), summaryEl: el.querySelector(".ts"), stEl: el.querySelector(".st"), status: live ? "run" : "done" };
    if (settings.autoExpandTools || name === "TodoWrite" || name === "Task" || name === "Agent" || name === "ExitPlanMode") el.open = name !== "Task" && name !== "Agent" ? true : false;
    this.tools.set(id, card);
    el._card = card;
    this.fillToolInput(card);
    if (name === "AskUserQuestion" || name === "ExitPlanMode") this.container(parentId).append(el); else this.place(el, parentId);
    return card;
  }
  /** deepseek_task / claude_task: one quiet line where the handoff happened ("Sent to DeepSeek: Add README · done ›").
   *  The card keeps the usual fields (detached) so results and statuses flow as for any tool. */
  handoffCard(id, name, input, parentId, live) {
    const el = h(`<div class="handoff"><button class="handoff-line"><span class="spark"></span><span class="hl-x"><span class="sl-t"></span><span class="hl-st"></span></span><span class="chev" aria-hidden="true">›</span></button></div>`);
    const card = { id, name, input, el, body: document.createElement("div"), summaryEl: document.createElement("span"), stEl: document.createElement("span"), status: live ? "run" : "done", handoff: true };
    el._card = card;
    this.tools.set(id, card);
    el.querySelector("button").onclick = () => { if (typeof openHandoff === "function") openHandoff(card); };
    this.container(parentId).append(el);
    this.fillToolInput(card);
    return card;
  }
  fillToolInput(card) {
    const { name, input } = card, body = card.body;
    card.summaryEl.textContent = toolSummary(name, input);
    if (card.el.isConnected) this.updateGroup(card.el.closest(".steps"));   // the line names what's running once its input arrives
    if (card.handoff) return handoffLine(card);
    body.querySelector(".tin")?.remove();
    const box = document.createElement("div"); box.className = "tin";
    if (name === "Bash") { box.append(codeBlock("$ " + (input.command || ""), "bash", true)); }
    else if (name === "Edit") { const d = diffView(diffLines(input.old_string, input.new_string)); box.append(d.el); card.summaryEl.innerHTML = `${esc(shortPath(input.file_path))} <span class="diff-stat"><span class="p">+${d.add}</span> <span class="m">-${d.del}</span></span>`; }
    else if (name === "MultiEdit") { for (const e of input.edits || []) box.append(diffView(diffLines(e.old_string, e.new_string)).el); }
    else if (name === "Write") { const lines = (input.content || "").split("\n").length; card.summaryEl.textContent = `${shortPath(input.file_path)} · ${lines} lines`; if (input.content != null) box.append(codeBlock(input.content, langOf(input.file_path))); }
    else if (name === "TodoWrite") { box.append(todoList(input.todos)); this.todos = input.todos; if (!this.embedded) updateTodoBar(input.todos); }
    else if (name === "ExitPlanMode") { const m = document.createElement("div"); m.className = "md"; setMd(m, input.plan || ""); box.append(m); }
    else if (name === "Task" || name === "Agent") { if (input.prompt) { const l = h(`<div class="lbl">Task</div>`); box.append(l, codeBlock(input.prompt, "", true)); } }
    else if (name === "AskUserQuestion") { for (const q of input.questions || []) box.append(h(`<div class="q-block"><div class="qh">${esc(q.header || "")}</div><div>${esc(q.question)}</div></div>`)); }
    else if (name === "Read") { if (input.offset || input.limit) box.append(h(`<div class="lbl">lines ${input.offset || 1}–${(input.offset || 1) + (input.limit || 0)}</div>`)); }
    else if (Object.keys(input || {}).length) { box.append(h(`<div class="lbl">Input</div>`), codeBlock(JSON.stringify(input, null, 2), "json", true)); }
    body.prepend(box);
  }
  toolResult(b, structured) {
    const card = this.tools.get(b.tool_use_id); if (!card) return;
    const text = resultText(b.content);
    const isErr = !!b.is_error;
    card.body.querySelector(".tout")?.remove();
    const out = document.createElement("div"); out.className = "tout";
    const name = card.name;
    if (card.handoff) { card.status = isErr ? "err" : "ok"; return handoffLine(card, text, isErr); }
    if (isErr) { out.append(h(`<div class="lbl">Error</div>`)); const p = codeBlock(text, "", true); p.classList.add("err-text"); out.append(p); }
    else if (name === "Edit" || name === "MultiEdit" || name === "Write") {
      const patch = structured?.structuredPatch;
      if (Array.isArray(patch) && patch.length && name !== "Write") {
        card.body.querySelector(".tin")?.remove();
        const lines = []; for (const hk of patch) { lines.push(`@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`); lines.push(...hk.lines); }
        const d = diffView(lines); out.append(d.el);
        card.summaryEl.innerHTML = `${esc(shortPath(card.input.file_path))} <span class="diff-stat"><span class="p">+${d.add}</span> <span class="m">-${d.del}</span></span>`;
      }
    } else if (name === "Read") { const n = text.split("\n").length; card.summaryEl.textContent = `${shortPath(card.input.file_path)} · ${n} lines`; out.append(codeBlock(text.replace(/^\s*\d+→/gm, ""), langOf(card.input.file_path))); }
    else if (name === "TodoWrite") { /* list already shown */ }
    else if (name === "Task" || name === "Agent") { const m = document.createElement("div"); m.className = "md"; setMd(m, text); out.append(h(`<div class="lbl">Result</div>`), m); }
    else if (name === "AskUserQuestion") { out.append(codeBlock(text, "", true)); }
    else if (text) { out.append(h(`<div class="lbl">${name === "Bash" ? "Output" : "Result"}</div>`), codeBlock(text.length > 30000 ? text.slice(0, 30000) + "\n… (truncated)" : text, "", name !== "Bash")); }
    if (Array.isArray(b.content)) for (const c of b.content) if (c.type === "image" && c.source?.data) { const i = document.createElement("img"); i.src = `data:${c.source.media_type};base64,${c.source.data}`; i.style.maxWidth = "100%"; out.append(i); }
    card.body.append(out);
    this.setStatus(card, isErr ? "err" : "ok");
  }
  setStatus(card, s) {
    card.status = s;
    if (card.handoff) return handoffLine(card);
    card.stEl.className = "st " + (s === "ok" ? "ok" : s === "err" ? "err" : "");
    card.stEl.innerHTML = s === "ok" ? icon("check") : s === "err" ? icon("x") : "";
    this.updateGroup(card.el.closest(".steps"));
  }

  // ───── thoughts: back-to-back thoughts share one collapsible block ─────
  thoughtSlot(parentId, live) {
    const parent = this.container(parentId);
    let head = parent.lastElementChild;
    if (!head?.classList.contains("thinking")) {
      head = h(`<details class="thinking"><summary>${icon("brain")}<span>Thought</span></summary><div class="th-body"></div></details>`);
      head.querySelector("summary").addEventListener("click", () => delete head.dataset.auto);   // the person's choice sticks
      parent.append(head);
    }
    // Withheld thinking streams as an empty block and then a block with its summary. The summary fills the
    // empty slot instead of adding a second entry to the same thought.
    let md = head.querySelector(".th-body > .md:last-child");
    if (!md?.dataset.live) {
      md = document.createElement("div"); md.className = "md";
      head.querySelector(".th-body").append(md);
    }
    if (live) {
      md.dataset.live = "1";
      head.classList.add("ghost");
      head.querySelector("summary span").textContent = "Thinking…";
      if (settings.showThinking && !head.open) { head.open = true; head.dataset.auto = "1"; }
    }
    return md;
  }
  endThought(head) {
    if (!head) return;
    head.classList.remove("ghost");
    if (head.dataset.auto) { head.open = false; delete head.dataset.auto; }
    const n = [...head.querySelectorAll(".th-body > .md")].filter(md => !md.dataset.live && md.textContent.trim()).length;
    head.querySelector("summary span").textContent = n > 1 ? `Thought · ${n} times` : "Thought";
  }

  // ───── grouped steps (steps.js): a run of top-level tool calls shares one line; thoughts stay in the chat ─────
  place(el, parentId) {
    if (parentId) return this.container(parentId).append(el);
    let g = this.root.lastElementChild;
    while (g?.classList.contains("thinking")) g = g.previousElementSibling;   // the run goes on past Claude's thoughts
    if (!g?.classList.contains("steps")) {
      g = h(`<div class="steps"><button class="steps-line"><span class="spark"></span><span class="sl-t"></span><span class="sl-err"></span><span class="chev">›</span></button><div class="steps-list"></div></div>`);
      g.querySelector(".steps-line").onclick = () => openSteps(g);
      this.root.append(g);
    }
    g.querySelector(".steps-list").append(el);
    this.updateGroup(g);
  }
  updateGroup(g) {
    if (!g) return;
    const cards = [...g.querySelector(".steps-list").children].map(e => e._card).filter(Boolean);
    const err = cards.filter(c => c.status === "err").length;
    g.classList.toggle("has-tools", cards.length > 0);
    g.classList.toggle("running", cards.some(c => c.status === "run"));
    g.querySelector(".sl-t").textContent = stepsSummary(cards);
    g.querySelector(".sl-err").textContent = err ? ` · ${err} failed` : "";
    if (sheet.key === "steps" && sheet.group === g) drawSteps(g);
  }

  // ───── misc ─────
  resultLine(ev) {
    for (const c of this.tools.values()) if (c.status === "run") this.setStatus(c, "unknown");
    // a turn that showed nothing (e.g. Claude Code noting that background tasks stopped) gets no line
    const quiet = !this.fresh && (!ev.subtype || ev.subtype === "success") && !ev.permission_denials?.length;
    this.fresh = false;
    if (quiet) return;
    const bits = [];
    if (ev.duration_ms) bits.push(fmtDur(ev.duration_ms));
    if (ev.usage) { const out = ev.usage.output_tokens || 0; if (out) bits.push(fmtTok(out) + " out"); }
    if (ev.num_turns > 1) bits.push(ev.num_turns + " steps");
    const errored = ev.subtype && ev.subtype !== "success";
    if (errored) this.note(ev.subtype === "error_max_turns" ? "Stopped: reached the turn limit." : ev.subtype === "error_during_execution" ? "The run stopped with an error." : `Stopped (${ev.subtype}).`, true);
    if (ev.permission_denials?.length) bits.push(`${ev.permission_denials.length} denied`);
    const line = h(`<div class="result-line"><span>${esc(bits.join(" · "))}</span><span class="grow"></span>
      <button data-a="copy">${icon("copy")}</button><button data-a="share">${icon("share")}</button><button data-a="retry">${icon("retry")}</button></div>`);
    const text = this.lastText;
    line.querySelector('[data-a="copy"]').onclick = () => copyText(text);
    line.querySelector('[data-a="share"]').onclick = () => shareText(text);
    if (this.embedded) line.querySelector('[data-a="retry"]').remove(); else line.querySelector('[data-a="retry"]').onclick = () => retryLast();
    this.root.append(line);
    this.scrollIfPinned();
  }
  /** A DeepSeek turn's estimated cost (the server's pa_cost event), on that turn's result line. */
  costNote(usd) {
    const line = [...this.root.querySelectorAll(":scope > .result-line")].pop();
    if (!line || !(usd > 0) || line.querySelector(".cost")) return;
    line.querySelector("span").insertAdjacentHTML("afterend", `<span class="cost" title="Estimated from token counts">≈ ${esc(typeof dsMoney === "function" ? dsMoney(usd) : "$" + usd.toFixed(3))}</span>`);
  }
  note(text, err) { this.root.append(h(`<div class="note ${err ? "err" : ""}">${esc(text)}</div>`)); this.scrollIfPinned(); }
  divider(text) { this.root.append(h(`<div class="divider">${esc(text)}</div>`)); }

  lastUserUuid() { for (let i = this.order.length - 1; i >= 0; i--) if (this.userTexts.has(this.order[i])) return this.order[i]; return null; }
  prevUuid(uuid) { const i = this.order.indexOf(uuid); return i > 0 ? this.order[i - 1] : null; }

  toMarkdown() {
    const parts = [];
    this.root.querySelectorAll(".user-msg-wrap, .md:not(.tool .md):not(.thinking .md):not(.task-msg .md), .tool, .handoff, .task-msg").forEach(el => {
      if (el.classList.contains("user-msg-wrap")) parts.push("**You:** " + el.querySelector(".bubble").textContent);
      else if (el.classList.contains("tool")) parts.push(`> ${el.querySelector(".tn").textContent}: ${el.querySelector(".ts").textContent}`);
      else if (el.classList.contains("handoff")) parts.push("> " + el.querySelector(".handoff-line").textContent.replace(/›\s*$/, "").replace(/\s+/g, " ").trim());
      else if (el.classList.contains("task-msg")) parts.push(`**${el.querySelector(".tm-h").textContent}:**\n\n` + el.querySelector(".md").innerText);
      else parts.push(el.innerText);
    });
    return parts.join("\n\n");
  }
}

/** The first message delegate.js sends a worker, or a follow-up: { from, task, followUp }, else null. */
function workerTask(text) {
  const t = String(text || "");
  const m = /^\[Pocket Agent\] You're a (?:DeepSeek|Claude) worker\. The (?:DeepSeek|Claude) chat "(.*?)" sent you this task\b/.exec(t)
    || /^\[Pocket Agent\] A follow-up from "(.*?)":\n/.exec(t);
  const cut = t.indexOf("\n\n");
  if (!m || cut < 0) return null;
  return { from: m[1] === "untitled" || m[1] === "the calling chat" ? "" : m[1], task: t.slice(cut + 2), followUp: t.startsWith("[Pocket Agent] A follow-up") };
}

function updateTodoBar(todos) {
  const bar = $("#todo-bar");
  if (!todos || !todos.length || todos.every(t => t.status === "completed")) { bar.hidden = true; return; }
  const done = todos.filter(t => t.status === "completed").length;
  const cur = todos.find(t => t.status === "in_progress");
  bar.hidden = false;
  bar.innerHTML = "";
  const d = h(`<details><summary>${icon("list")}<span>${done}/${todos.length} · ${esc(cur ? cur.activeForm || cur.content : "Tasks")}</span></summary></details>`);
  d.append(todoList(todos)); bar.append(d);
}
