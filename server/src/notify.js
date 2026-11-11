// Decides what the phone shows as notifications. The app renders whatever spec we send
// (app/src/.../Notifier.java), so changing notification wording, buttons or behaviour
// here needs no app update.
//
// Input: the same internal events LiveSession emits via notifyNative():
//   permission.request | permission.resolved | done | activity
// Output: a list of { type: "notify", spec } / { type: "cancel", id } messages.

const approvalId = requestId => "approval:" + requestId;

export function toNative(ev) {
  switch (ev.type) {
    case "permission.request": {
      const special = ev.toolName === "AskUserQuestion" ? "Claude has a question" : ev.toolName === "ExitPlanMode" ? "Claude's plan is ready" : null;
      const spec = {
        id: approvalId(ev.requestId), channel: "approval", prefKey: "notifyApproval", onlyWhenBackground: true,
        title: special || `Allow ${ev.toolName}?`, text: String(ev.input || ""), subText: ev.title || "",
        tap: { sessionId: ev.sessionId },
      };
      // Questions and plans need the full UI; simple approvals can be answered from the notification.
      if (!special) spec.actions = [
        { label: "Allow", toast: "Allowed", post: { path: "/permission", body: { sessionId: ev.sessionId, requestId: ev.requestId, behavior: "allow" } } },
        { label: "Deny", toast: "Denied", post: { path: "/permission", body: { sessionId: ev.sessionId, requestId: ev.requestId, behavior: "deny" } } },
      ];
      return [{ type: "notify", spec }];
    }
    case "permission.resolved":
      return [{ type: "cancel", id: approvalId(ev.requestId) }];
    case "done":
      return [{ type: "notify", spec: { id: "done:" + ev.sessionId, channel: "done", prefKey: "notifyDone", onlyWhenBackground: true,
        title: `Done: ${ev.title || "Claude"}`, text: ev.text || "", tap: { sessionId: ev.sessionId } } }];
    case "activity": {
      const busy = !["idle", "error", "starting"].includes(ev.phase);
      const spec = busy
        ? { id: "status", channel: "status", ongoing: true, onlyAlertOnce: true, title: ev.label, text: ev.detail || "", subText: ev.title || "",
            chronometerStart: ev.turnStart || undefined, tap: { sessionId: ev.sessionId } }
        : { id: "status", channel: "status", ongoing: true, title: "Pocket Agent", text: "Listening for Claude" };
      return [{ type: "notify", spec }];
    }
  }
  return [];
}
