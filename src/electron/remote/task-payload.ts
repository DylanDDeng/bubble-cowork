import type { SessionContinuePayload } from "../../shared/types";
import type { RemoteTaskExtras } from "./gateway";

// Modes the phone may pick; same values as the desktop permission menus.
// Plan is its own toggle (execution mode), as on the desktop.
const PERMISSION_MODES: Record<string, string[]> = {
  claude: ["default", "auto", "acceptEdits", "dontAsk", "bypassPermissions"],
  codex: ["defaultPermissions", "auto", "fullAccess"],
  bubble: ["default", "bypassPermissions"],
  // Devin's plan is one of its ACP session modes, picked in the same menu.
  devin: ["accept-edits", "smart", "ask", "plan", "bypass"],
  // MiMo's plan is one of its agents, like Devin's.
  mimo: ["ask", "plan", "build"],
};
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Maps phone task settings onto the desktop composer's payload fields. */
export function remoteTaskPayload(
  provider: string,
  extras: RemoteTaskExtras = {},
): Partial<SessionContinuePayload> {
  const s = extras.settings ?? {};
  const mode = s.permissionMode && PERMISSION_MODES[provider]?.includes(s.permissionMode) ? s.permissionMode : undefined;
  const payload: Partial<SessionContinuePayload> = {
    model: s.model || undefined,
    attachments: extras.attachments?.length ? extras.attachments : undefined,
  };
  if (provider === "claude") {
    payload.compatibleProviderId = (s.compatibleProviderId || undefined) as SessionContinuePayload["compatibleProviderId"];
    payload.claudeAccessMode = (mode ?? "default") as SessionContinuePayload["claudeAccessMode"];
    payload.claudeExecutionMode = s.plan ? "plan" : "execute";
    if (s.effort && CLAUDE_EFFORTS.includes(s.effort))
      payload.claudeReasoningEffort = s.effort as SessionContinuePayload["claudeReasoningEffort"];
  } else if (provider === "codex") {
    payload.codexPermissionMode = (mode ?? "defaultPermissions") as SessionContinuePayload["codexPermissionMode"];
    payload.codexExecutionMode = s.plan ? "plan" : "execute";
    payload.codexReasoningEffort = s.effort || undefined;
    payload.codexFastMode = s.fast ?? undefined;
  } else if (provider === "bubble") {
    const base = (mode ?? "default") as "default" | "bypassPermissions";
    payload.bubblePermissionMode = s.plan ? "plan" : base;
    payload.bubblePlanExitMode = base === "bypassPermissions" ? "bypassPermissions" : "default";
    payload.bubbleThinkingLevel = s.effort || undefined;
  } else if (provider === "devin") {
    payload.devinPermissionMode = (mode ?? "accept-edits") as SessionContinuePayload["devinPermissionMode"];
    // Thinking levels are an open set per model; the desktop validates them.
    payload.devinThoughtLevel = s.effort || undefined;
  } else if (provider === "mimo") {
    payload.mimoPermissionMode = (mode ?? "ask") as SessionContinuePayload["mimoPermissionMode"];
    // Variants are an open set per model; the desktop validates them.
    payload.mimoReasoningEffort = s.effort || undefined;
  }
  return payload;
}

