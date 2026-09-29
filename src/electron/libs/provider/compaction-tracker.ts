import { v4 as uuidv4 } from 'uuid';
import type { ProviderRuntimeEvent } from './types';

type Session = { threadId: string; providerSessionId?: string | null };
type Details = { id?: string; trigger?: 'auto' | 'manual'; preTokens?: number; createdAt?: number };
type Attempt = Details & { id: string; nativeId?: string };

/** Normalize native lifecycles without requiring providers to invent a start event. */
export class CompactionTracker {
  private active = new WeakMap<Session, Attempt>();
  private interrupted = new WeakMap<Session, Map<string, Attempt>>();
  private finished = new WeakMap<Session, Set<string>>();

  constructor(private emit: (event: ProviderRuntimeEvent) => void) {}

  /** Returns true only when this event opens a new compaction attempt. */
  start(session: Session, details: Details = {}): boolean {
    if (this.active.has(session) || (details.id && (
      this.finished.get(session)?.has(details.id) || this.interrupted.get(session)?.has(details.id)
    ))) return false;
    const current = { ...details, id: details.id || uuidv4(), nativeId: details.id };
    this.active.set(session, current);
    this.emit({ type: 'message', threadId: session.threadId, message: {
      type: 'system', subtype: 'compact_status', uuid: uuidv4(),
      session_id: session.providerSessionId || session.threadId,
      compactionId: current.id, createdAt: details.createdAt ?? Date.now(),
      status: 'started', trigger: details.trigger ?? 'auto',
    } });
    return true;
  }

  complete(session: Session, details: Details = {}): void {
    if (details.id && this.finished.get(session)?.has(details.id)) return;
    const active = this.active.get(session);
    // A late native completion belongs to its original attempt, even if another
    // attempt is now active. Only an unidentified start (e.g. Qoder status) may
    // acquire a native ID from its completion.
    const previous = details.id ? this.interrupted.get(session)?.get(details.id) : undefined;
    const current = previous ?? (active && (
      !details.id || !active.nativeId || active.nativeId === details.id
    ) ? active : undefined);
    const id = current?.id || details.id || uuidv4();
    if (current === active) this.active.delete(session);
    this.interrupted.get(session)?.delete(id);
    const finished = this.finished.get(session) || new Set<string>();
    finished.add(id);
    if (details.id) finished.add(details.id);
    // Bound native event replay bookkeeping for long-running sessions.
    while (finished.size > 256) finished.delete(finished.values().next().value!);
    this.finished.set(session, finished);
    this.emit({ type: 'message', threadId: session.threadId, message: {
      type: 'system', subtype: 'compact_boundary', uuid: uuidv4(),
      session_id: session.providerSessionId || session.threadId,
      compactionId: id, createdAt: details.createdAt ?? Date.now(),
      compactMetadata: {
        trigger: details.trigger ?? current?.trigger ?? 'auto',
        preTokens: details.preTokens ?? current?.preTokens ?? 0,
      },
    } });
  }

  interrupt(session: Session, id?: string): void {
    const current = this.active.get(session);
    if (!current || (id && current.id !== id)) return;
    this.active.delete(session);
    const interrupted = this.interrupted.get(session) || new Map<string, Attempt>();
    interrupted.set(current.id, current);
    while (interrupted.size > 256) interrupted.delete(interrupted.keys().next().value!);
    this.interrupted.set(session, interrupted);
    this.emit({ type: 'message', threadId: session.threadId, message: {
      type: 'system', subtype: 'compact_status', uuid: uuidv4(),
      session_id: session.providerSessionId || session.threadId,
      compactionId: current.id, createdAt: Date.now(), status: 'interrupted',
      trigger: current.trigger ?? 'auto',
    } });
  }
}
