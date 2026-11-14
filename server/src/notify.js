// Decides what the phone shows as notifications. The app renders whatever spec we send
// (app/src/.../Notifier.java), so changing notification wording, buttons or behaviour
// here needs no app update.
//
// Input: the same internal events LiveSession emits via notifyNative():
//   permission.request | permission.resolved | done | activity   (each with `engine`: "claude" | "deepseek")
// Output: a list of { type: "notify", spec } / { type: "cancel", id } messages.

const approvalId = requestId => "approval:" + requestId;
// Handing work to the other engine: no buttons, so the person reads the whole task in the app first.
const DELEGATION = { mcp__pocket__deepseek_task: "Send work to DeepSeek?", mcp__pocket__claude_task: "Ask Claude?" };
const ENGINE = { deepseek: "DeepSeek", claude: "Claude" };
const subText = ev => (ev.engine === "deepseek" ? "DeepSeek · " : "") + (ev.title || "");
/** A worker's approval is headed like the app's sheet: "DeepSeek · Add README wants to run npm test". */
const workerHeading = ev => `${ENGINE[ev.engine] || "Claude"} · ${ev.title || "Worker"} ${ev.ask || `wants to use ${ev.toolName}`}`;

export function toNative(ev) {
  switch (ev.type) {
    case "permission.request": {
      const worker = !!ev.parent;   // a worker chat's request: it shows in the chat that started the worker
      const special = ev.toolName === "AskUserQuestion" ? "Claude has a question" : ev.toolName === "ExitPlanMode" ? "Claude's plan is ready" : DELEGATION[ev.toolName] || null;
      const spec = {
        id: approvalId(ev.requestId), channel: "approval", prefKey: "notifyApproval", onlyWhenBackground: true,
        title: worker ? workerHeading(ev) : special || `Allow ${ev.toolName}?`, text: String(ev.input || ""),
        subText: worker ? ev.parentTitle || subText(ev) : subText(ev),
        tap: { sessionId: worker ? ev.parent : ev.sessionId },
      };
      // Questions, plans and delegations need the full UI; simple approvals can be answered from the notification.
      const answer = (label, toast, extra) => ({ label, toast, post: { path: "/permission", body: { sessionId: ev.sessionId, requestId: ev.requestId, ...extra } } });
      if (!special) spec.actions = [answer("Allow", "Allowed", { behavior: "allow" }),
        ...(worker ? [answer("Allow all", "Allowed until it finishes", { behavior: "allow", allowAll: true })] : []),
        answer("Deny", "Denied", { behavior: "deny" })];
      return [{ type: "notify", spec }];
    }
    case "permission.resolved":
      return [{ type: "cancel", id: approvalId(ev.requestId) }];
    case "done":
      return [{ type: "notify", spec: { id: "done:" + ev.sessionId, channel: "done", prefKey: "notifyDone", onlyWhenBackground: true,
        title: `Done: ${ev.title || "Claude"}`, text: ev.text || "", ...(ev.engine === "deepseek" ? { subText: "DeepSeek" } : {}), tap: { sessionId: ev.sessionId } } }];
    case "activity": {
      const busy = !["idle", "error", "starting"].includes(ev.phase);
      const spec = busy
        ? { id: "status", channel: "status", ongoing: true, onlyAlertOnce: true, title: ev.label, text: ev.detail || "", subText: subText(ev),
            chronometerStart: ev.turnStart || undefined, tap: { sessionId: ev.sessionId } }
        : { id: "status", channel: "status", ongoing: true, title: "Pocket Agent", text: "Listening for Claude" };
      return [{ type: "notify", spec }];
    }
  }
  return [];
}
