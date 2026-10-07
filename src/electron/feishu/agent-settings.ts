// What a Feishu-started task runs with: the chat's /agent choices layered over
// the desktop composer's remembered defaults (provider, model, permission and
// reasoning per provider), mapped onto the session start payload.
import { existsSync, readFileSync } from "fs";
import type { AgentProvider, SessionStartPayload } from "../../shared/types";
import {
  BUBBLE_PERMISSION_MODE_OPTIONS,
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_PERMISSION_MODE_OPTIONS,
  DEEPSEEK_PERMISSION_MODE_OPTIONS,
  DEVIN_PERMISSION_MODE_OPTIONS,
  KIMI_PERMISSION_MODE_OPTIONS,
  MIMO_PERMISSION_MODE_OPTIONS,
  OPENCODE_PERMISSION_MODE_OPTIONS,
  QODER_PERMISSION_MODE_OPTIONS,
  type PermissionModeOption,
} from "../../ui/utils/permission-modes";
import type { ScopePrefs } from "./store";

export const PROVIDERS: AgentProvider[] = ["claude", "codex", "bubble", "devin", "mimo", "kimi", "grok", "deepseek", "opencode", "qoder", "pi"];
export const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  bubble: "Bubble",
  devin: "Devin",
  mimo: "MiMo",
  kimi: "Kimi",
  grok: "Grok",
  deepseek: "DeepSeek",
  opencode: "OpenCode",
  qoder: "Qoder",
  pi: "Pi",
};

/** Permission menus per provider, the same lists the desktop composer shows. */
export const PERMISSION_OPTIONS: Record<string, ReadonlyArray<PermissionModeOption<string>>> = {
  claude: CLAUDE_PERMISSION_MODE_OPTIONS,
  codex: CODEX_PERMISSION_MODE_OPTIONS,
  bubble: BUBBLE_PERMISSION_MODE_OPTIONS,
  devin: DEVIN_PERMISSION_MODE_OPTIONS,
  mimo: MIMO_PERMISSION_MODE_OPTIONS,
  kimi: KIMI_PERMISSION_MODE_OPTIONS,
  grok: KIMI_PERMISSION_MODE_OPTIONS,
  deepseek: DEEPSEEK_PERMISSION_MODE_OPTIONS,
  opencode: OPENCODE_PERMISSION_MODE_OPTIONS,
  qoder: QODER_PERMISSION_MODE_OPTIONS,
};

const cap = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1);

/** The renderer's persisted composer choices (`cowork.preferred*`), read-only. */
export function readDesktopPreferences(file: string): Record<string, string> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function perModel(raw: string | undefined, model: string | undefined): string | undefined {
  if (!raw || !model) return undefined;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)[model];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedAgent {
  provider: AgentProvider;
  model?: string;
  permissionMode?: string;
  payload: Partial<SessionStartPayload>;
}

/** Chat choices over desktop defaults → session start fields. */
export function resolveAgent(prefs: ScopePrefs, desktop: Record<string, string>): ResolvedAgent {
  const provider = (PROVIDERS.includes(prefs.provider as AgentProvider)
    ? prefs.provider
    : PROVIDERS.includes(desktop["cowork.preferredProvider"] as AgentProvider)
      ? desktop["cowork.preferredProvider"]
      : "claude") as AgentProvider;
  const sameProvider = !prefs.provider || prefs.provider === provider;
  const model = (sameProvider && prefs.model) || desktop[`cowork.preferred${cap(provider)}Model`] || undefined;
  // Grok shares Kimi's permission state on the desktop.
  const permissionKey = `cowork.preferred${provider === "grok" ? "Kimi" : cap(provider)}PermissionMode`;
  const permissionMode = (sameProvider && prefs.permissionMode) || desktop[permissionKey] || undefined;
  const payload: Partial<SessionStartPayload> = { provider, model };
  const plan = permissionMode === "plan";
  switch (provider) {
    case "claude":
      payload.claudeAccessMode = (plan ? "default" : permissionMode ?? "default") as SessionStartPayload["claudeAccessMode"];
      payload.claudeExecutionMode = plan ? "plan" : "execute";
      payload.claudeReasoningEffort = perModel(desktop["cowork.preferredClaudeReasoningEfforts"], model) as SessionStartPayload["claudeReasoningEffort"];
      payload.compatibleProviderId = (desktop["cowork.preferredClaudeCompatibleProvider"] || undefined) as SessionStartPayload["compatibleProviderId"];
      break;
    case "codex":
      payload.codexPermissionMode = (permissionMode ?? "defaultPermissions") as SessionStartPayload["codexPermissionMode"];
      payload.codexExecutionMode = desktop["cowork.preferredCodexExecutionMode"] === "plan" ? "plan" : "execute";
      payload.codexReasoningEffort = perModel(desktop["cowork.preferredCodexReasoningEfforts"], model);
      try {
        const fast = model ? JSON.parse(desktop["cowork.preferredCodexFastModeByModel"] || "{}")[model] : undefined;
        if (typeof fast === "boolean") payload.codexFastMode = fast;
      } catch {}
      break;
    case "bubble": {
      const base = permissionMode === "bypassPermissions" ? "bypassPermissions" : "default";
      payload.bubblePermissionMode = plan ? "plan" : base;
      payload.bubblePlanExitMode = base;
      payload.bubbleThinkingLevel = perModel(desktop["cowork.preferredBubbleThinkingLevels"], model);
      break;
    }
    case "devin":
      payload.devinPermissionMode = (permissionMode ?? "accept-edits") as SessionStartPayload["devinPermissionMode"];
      payload.devinThoughtLevel = perModel(desktop["cowork.preferredDevinThoughtLevels"], model);
      break;
    case "mimo":
      payload.mimoPermissionMode = (permissionMode ?? "ask") as SessionStartPayload["mimoPermissionMode"];
      payload.mimoReasoningEffort = perModel(desktop["cowork.preferredMimoReasoningEfforts"], model);
      break;
    case "kimi":
      payload.kimiPermissionMode = (permissionMode ?? "default") as SessionStartPayload["kimiPermissionMode"];
      payload.kimiThinking = desktop["cowork.preferredKimiThinking"] || undefined;
      break;
    case "grok":
      payload.grokPermissionMode = (permissionMode ?? "default") as SessionStartPayload["grokPermissionMode"];
      payload.grokReasoningEffort = perModel(desktop["cowork.preferredGrokReasoningEfforts"], model) as SessionStartPayload["grokReasoningEffort"];
      break;
    case "deepseek":
      payload.deepseekPermissionMode = (permissionMode ?? "workspace-write") as SessionStartPayload["deepseekPermissionMode"];
      payload.deepseekAgentPreset = (desktop["cowork.preferredDeepseekAgentPreset"] || undefined) as SessionStartPayload["deepseekAgentPreset"];
      payload.deepseekReasoningEffort = (desktop["cowork.preferredDeepseekReasoningEffort"] || undefined) as SessionStartPayload["deepseekReasoningEffort"];
      break;
    case "opencode":
      payload.opencodePermissionMode = (permissionMode ?? "defaultPermissions") as SessionStartPayload["opencodePermissionMode"];
      break;
    case "qoder":
      payload.qoderPermissionMode = (permissionMode ?? "default") as SessionStartPayload["qoderPermissionMode"];
      break;
  }
  return { provider, model, permissionMode, payload };
}

export function permissionLabel(provider: string, mode: string | undefined): string {
  if (!mode) return "Default";
  return PERMISSION_OPTIONS[provider]?.find((o) => o.mode === mode)?.label ?? mode;
}
