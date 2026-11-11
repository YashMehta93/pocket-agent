// An async queue used as the SDK's streaming input: each push() becomes a user
// message in the running Claude Code session; end() closes the session's input.
export class Inbox {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
        : this.done ? Promise.resolve({ value: undefined, done: true })
        : new Promise(r => this.waiters.push(r)),
    };
  }
}
