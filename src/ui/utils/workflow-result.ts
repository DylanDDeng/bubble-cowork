// Workflow members (and the chat session when it takes part in a workflow)
// end their reply with a fenced JSON result for the workflow engine. That
// block is machine input; the conversation shows it as one collapsed line.

export type WorkflowResultSplit = { body: string; result: string | null };

const CLOSED_FENCE = /^```json[ \t]*\n([\s\S]*)\n```\s*$/;
const VERDICTS = new Set(['approved', 'changes_requested', 'blocked']);
const STATUSES = new Set(['completed', 'blocked']);

/** True for the result shapes the workflow engine asks members for (implementation, review, notes). */
function isWorkflowResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return false;
  if (typeof record.verdict === 'string') return VERDICTS.has(record.verdict);
  if (typeof record.status === 'string') return STATUSES.has(record.status) && typeof record.summary === 'string';
  return typeof record.summary === 'string' && typeof record.details === 'string';
}

/** Separate a trailing workflow result block from the readable reply. */
export function splitWorkflowResult(text: string): WorkflowResultSplit {
  // The last json fence, and only when it closes the reply.
  const start = text.lastIndexOf('```json');
  const match = start >= 0 ? CLOSED_FENCE.exec(text.slice(start)) : null;
  if (!match) return { body: text, result: null };
  try {
    if (!isWorkflowResult(JSON.parse(match[1]))) return { body: text, result: null };
  } catch {
    return { body: text, result: null };
  }
  return { body: text.slice(0, start).trimEnd(), result: match[1] };
}
