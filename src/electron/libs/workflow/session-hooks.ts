// Hooks the session runtime (ipc-handlers startRunner) calls so workflow
// member sessions can be held to their policy and observed turn by turn,
// without the workflow host reaching into the runner bookkeeping.

import type { StreamMessage } from '../../types';
import type { WorkflowSessionPolicy } from '../../../shared/workflow';

const policies = new Map<string, WorkflowSessionPolicy>();

export function setWorkflowSessionPolicy(sessionId: string, policy: WorkflowSessionPolicy): void {
  policies.set(sessionId, policy);
}

export function getWorkflowSessionPolicy(sessionId: string): WorkflowSessionPolicy | undefined {
  return policies.get(sessionId);
}

export function clearWorkflowSessionPolicy(sessionId: string): void {
  policies.delete(sessionId);
}

export type TurnOutcome = {
  status: 'completed' | 'error' | 'stopped';
  /** Text of the assistant messages produced in this turn, in order. */
  text: string;
  error?: string;
  deniedTools: string[];
};

type Waiter = {
  resolve: (outcome: TurnOutcome) => void;
  /** Keyed by message uuid: the store upserts by uuid, so a re-emitted message replaces its text. */
  texts: Map<string, string>;
  deniedTools: string[];
};

const joined = (waiter: Waiter) => [...waiter.texts.values()].join('\n\n');

const waiters = new Map<string, Waiter>();

/**
 * Register interest in the next turn of a session. Must be called before the
 * prompt is dispatched so no message of that turn is missed.
 */
export function expectTurn(sessionId: string): Promise<TurnOutcome> {
  const existing = waiters.get(sessionId);
  if (existing) existing.resolve({ status: 'stopped', text: '', error: 'superseded', deniedTools: [] });
  return new Promise<TurnOutcome>((resolve) => {
    waiters.set(sessionId, { resolve, texts: new Map(), deniedTools: [] });
  });
}

export function cancelTurnExpectation(sessionId: string): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  waiters.delete(sessionId);
  waiter.resolve({ status: 'stopped', text: joined(waiter), error: 'cancelled', deniedTools: waiter.deniedTools });
}

export function observeTurnMessage(sessionId: string, message: StreamMessage): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  const text = assistantText(message);
  if (!text) return;
  const uuid = (message as { uuid?: string }).uuid ?? `anon-${waiter.texts.size}`;
  waiter.texts.set(uuid, text);
}

export function recordDeniedTool(sessionId: string, toolName: string): void {
  waiters.get(sessionId)?.deniedTools.push(toolName);
}

const ERROR_DETAIL_GRACE_MS = 1_500;
const pendingErrorSettles = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A failed turn's result often arrives before the runner error that carries
 * the reason (e.g. an exhausted account balance). An error settle without a
 * message waits briefly so that reason can fill it in.
 */
export function settleTurn(sessionId: string, status: TurnOutcome['status'], error?: string): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  const pending = pendingErrorSettles.get(sessionId);
  if (status === 'error' && !error && !pending) {
    pendingErrorSettles.set(
      sessionId,
      setTimeout(() => {
        pendingErrorSettles.delete(sessionId);
        resolveWaiter(sessionId, 'error');
      }, ERROR_DETAIL_GRACE_MS),
    );
    return;
  }
  if (pending) {
    clearTimeout(pending);
    pendingErrorSettles.delete(sessionId);
    if (status === 'error') {
      resolveWaiter(sessionId, 'error', error);
      return;
    }
  }
  resolveWaiter(sessionId, status, error);
}

function resolveWaiter(sessionId: string, status: TurnOutcome['status'], error?: string): void {
  const waiter = waiters.get(sessionId);
  if (!waiter) return;
  waiters.delete(sessionId);
  waiter.resolve({
    status,
    text: joined(waiter),
    ...(error ? { error } : {}),
    deniedTools: waiter.deniedTools,
  });
}

/** Final (non-partial) assistant text in either the SDK or adapter message shape. */
export function assistantText(message: StreamMessage): string {
  const m = message as unknown as {
    type?: string;
    streaming?: boolean;
    parent_tool_use_id?: string | null;
    message?: { content?: unknown };
    content?: unknown;
  };
  if (m.type !== 'assistant' || m.streaming === true) return '';
  // Sub-agent output is not the member's answer.
  if (m.parent_tool_use_id) return '';
  const content = m.message?.content ?? m.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text',
    )
    .map((block) => block.text)
    .join('');
}

/** Tool inputs that would start work outliving the turn (plan §6.3). */
export function requestsBackgroundExecution(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const record = input as Record<string, unknown>;
  return record.run_in_background === true || record.background === true || record.detach === true;
}
