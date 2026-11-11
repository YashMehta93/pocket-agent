// Fan-out of server events to connected clients.
//   - WebSocket clients: the app UI (main protocol, see docs/PROTOCOL.md)
//   - SSE clients: the app's native notification service (approvals, activity, "done")

export const clients = new Set();     // WebSocket connections, each with ws.subs = Set<sessionId>
export const sseClients = new Set();  // http.ServerResponse objects

/** Send to clients subscribed to msg.sessionId (or to everyone if the message has no sessionId). */
export function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1 && (!msg.sessionId || c.subs.has(msg.sessionId))) c.send(s);
}

/** Send to every connected client. */
export function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

/** Send to the native notification service(s). */
export function notifyNative(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of sseClients) r.write(s);
}
