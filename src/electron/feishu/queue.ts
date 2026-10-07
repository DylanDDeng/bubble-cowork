// Per-scope inbound batching: messages that arrive within a short quiet window
// go to the agent together, and messages that arrive while a run is active
// wait and become the next batch (one run per scope at a time).

export interface QueuedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  /** Attachment ids already imported into Aegis. */
  attachments: unknown[];
}

export class ScopeQueue {
  private pending = new Map<string, QueuedMessage[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private blocked = new Set<string>();

  constructor(
    private flush: (scope: string, batch: QueuedMessage[]) => void,
    private quietMs = 600,
  ) {}

  push(scope: string, message: QueuedMessage) {
    const list = this.pending.get(scope) ?? [];
    list.push(message);
    this.pending.set(scope, list);
    if (!this.blocked.has(scope)) this.arm(scope);
  }

  /** A run started for this scope: hold new messages until `unblock`. */
  block(scope: string) {
    this.blocked.add(scope);
    clearTimeout(this.timers.get(scope));
    this.timers.delete(scope);
  }

  unblock(scope: string) {
    if (!this.blocked.delete(scope)) return;
    if (this.pending.get(scope)?.length) this.arm(scope);
  }

  isBlocked(scope: string) {
    return this.blocked.has(scope);
  }

  /** Drops and returns what was waiting (e.g. after /stop or /new). */
  cancel(scope: string): QueuedMessage[] {
    clearTimeout(this.timers.get(scope));
    this.timers.delete(scope);
    const list = this.pending.get(scope) ?? [];
    this.pending.delete(scope);
    return list;
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(scope: string) {
    clearTimeout(this.timers.get(scope));
    this.timers.set(
      scope,
      setTimeout(() => {
        this.timers.delete(scope);
        const batch = this.pending.get(scope) ?? [];
        this.pending.delete(scope);
        if (batch.length) this.flush(scope, batch);
      }, this.quietMs),
    );
  }
}

/** One prompt from a batch; several senders are labelled so the agent can tell them apart. */
export function batchPrompt(batch: QueuedMessage[]): string {
  const senders = new Set(batch.map((m) => m.senderId));
  if (senders.size <= 1) return batch.map((m) => m.text).filter(Boolean).join("\n\n");
  return batch
    .filter((m) => m.text)
    .map((m) => `[${m.senderName || m.senderId}]: ${m.text}`)
    .join("\n\n");
}
