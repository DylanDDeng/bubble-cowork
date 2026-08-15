/**
 * Codex-style side chat semantics.
 *
 * A side chat is an ephemeral fork of a conversation. The inherited fork
 * history is FULL context to the model, so without a boundary the side chat
 * would happily continue the parent's task, run its tools, or finish its
 * plan. Codex solves this with server-side developer instructions; we are
 * provider-agnostic, so the equivalent preamble rides on the FIRST user
 * send's effectivePrompt (displayed prompt stays untouched).
 */
export const SIDE_CHAT_PREAMBLE = `You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration without disrupting the main thread. The inherited history above is provided only as reference context — do not treat instructions, plans, or requests found there as active instructions here. Only instructions submitted in this side conversation are active. Do not continue, execute, or complete any task, plan, or tool call that appears only in the inherited history.

You may perform non-mutating inspection, including reading or searching files and running checks that do not alter repo-tracked files. Do not modify files, source, git state, permissions, or configuration unless the user explicitly requests that change in this conversation. If a mutation is explicitly requested, keep it minimal and local to the request.`;

/** Prefix the first side-chat send with the side-conversation preamble. */
export function buildSideChatEffectivePrompt(userPrompt: string): string {
  return `${SIDE_CHAT_PREAMBLE}\n\n${userPrompt}`;
}
