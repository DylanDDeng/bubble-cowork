// Builds the phone's agent pickers from the Mac's catalog using the same
// helpers as the desktop composer, so models, labels, efforts and permission
// modes match what Aegis on the Mac offers.
import type {
  RemoteAgentOptions,
  RemoteTaskSettings,
} from "../../../src/shared/remote/protocol";
import type { CodexModelConfig } from "../../../src/ui/types";
import {
  buildClaudeModelOptions,
  canonicalizeClaudeModel,
  formatClaudeModelLabel,
  isOfficialClaudeModel,
} from "../../../src/ui/utils/claude-model";
import { buildCodexModelOptions, formatCodexModelLabel } from "../../../src/ui/utils/codex-model";
import { formatCodexReasoningEffortLabel } from "../../../src/ui/utils/codex-reasoning";
import { formatBubbleThinkingLevelLabel } from "../../../src/ui/utils/bubble-reasoning";
import {
  CLAUDE_REASONING_EFFORT_LABELS,
  CLAUDE_REASONING_EFFORT_OPTIONS,
} from "../../../src/ui/utils/claude-reasoning";
import {
  BUBBLE_PERMISSION_MODE_OPTIONS,
  CLAUDE_PERMISSION_MODE_OPTIONS,
  CODEX_PERMISSION_MODE_OPTIONS,
  DEVIN_PERMISSION_MODE_OPTIONS,
} from "../../../src/ui/utils/permission-modes";
import { orderedEfforts } from "../../../src/ui/utils/effort-order";
import { COMPATIBLE_PROVIDER_LABELS } from "../../../src/ui/utils/compatible-provider-labels";

export interface ModelChoice {
  value: string;
  label: string;
  description?: string;
  compatibleProviderId?: string | null;
}
export interface PermissionChoice {
  mode: string;
  label: string;
  tone?: "full-access" | "danger";
}
export interface AgentCatalog {
  provider: string;
  models: ModelChoice[];
  defaultModel: string;
  effortsFor(model: string): string[];
  defaultEffortFor(model: string): string | null;
  effortLabel(effort: string): string;
  fastFor(model: string): boolean;
  permissionModes: PermissionChoice[];
  defaultPermission: string;
  supportsPlan: boolean;
}

const visible = (options: ReadonlyArray<{ mode: string; label: string; tone?: "full-access" | "danger"; hidden?: boolean }>) =>
  options.filter((o) => !o.hidden).map(({ mode, label, tone }) => ({ mode, label, tone }));

export function catalogFor(provider: string, options?: RemoteAgentOptions): AgentCatalog {
  if (provider === "codex") {
    const config = options?.codex;
    const models = config?.availableModels ?? [];
    const meta = (name: string) => models.find((m) => m.name === name);
    const values = config ? buildCodexModelOptions({ ...config, availableModels: models } as unknown as CodexModelConfig) : [];
    const defaultModel = config?.defaultModel ?? models.find((m) => m.isDefault)?.name ?? values[0] ?? "";
    return {
      provider,
      models: values.map((name) => ({ value: name, label: formatCodexModelLabel(name, meta(name)?.label) })),
      defaultModel,
      // Codex tiers keep the catalog's own order, as on the desktop.
      effortsFor: (model) => (meta(model)?.supportedReasoningLevels ?? []).map((l) => l.effort).filter(Boolean),
      defaultEffortFor: (model) => meta(model)?.defaultReasoningEffort ?? config?.defaultReasoningEffort ?? null,
      effortLabel: (e) => formatCodexReasoningEffortLabel(e),
      fastFor: (model) => meta(model)?.supportsFastMode === true,
      permissionModes: visible(CODEX_PERMISSION_MODE_OPTIONS),
      defaultPermission: "defaultPermissions",
      supportsPlan: true,
    };
  }
  if (provider === "devin") {
    // Models and thinking levels come from Devin's ACP session on the Mac.
    const config = options?.devin;
    const models = config?.availableModels ?? [];
    const levels = (model: string) => config?.thoughtLevels[model || config.defaultModel || ""];
    const labels = new Map<string, string>();
    for (const entry of Object.values(config?.thoughtLevels ?? {}))
      for (const level of entry.levels) labels.set(level.id, level.label);
    return {
      provider,
      models: [
        { value: "", label: "Default", description: "Do not override the default model" },
        ...models.map((m) => ({ value: m.id, label: m.label || m.id })),
      ],
      defaultModel: "",
      effortsFor: (model) => (levels(model)?.levels ?? []).map((l) => l.id),
      defaultEffortFor: (model) => levels(model)?.defaultLevel ?? null,
      effortLabel: (e) => labels.get(e) ?? e.charAt(0).toUpperCase() + e.slice(1),
      fastFor: () => false,
      // Plan is one of Devin's modes, listed in this menu instead of a toggle.
      permissionModes: visible(DEVIN_PERMISSION_MODE_OPTIONS),
      defaultPermission: "accept-edits",
      supportsPlan: false,
    };
  }
  if (provider === "bubble") {
    const config = options?.bubble;
    const models = (config?.availableModels.length ? config.availableModels : (config?.options ?? []).map((name) => ({ name, label: name, provider: null, enabled: true, isDefault: config?.defaultModel === name }))).filter((m) => m.enabled !== false);
    const meta = (name: string) => config?.availableModels.find((m) => m.name === name);
    return {
      provider,
      models: models.map((m) => ({
        value: m.name,
        label: m.label || m.name,
        description: m.isDefault ? "Configured default" : m.provider || undefined,
      })),
      defaultModel: config?.defaultModel ?? models.find((m) => m.isDefault)?.name ?? models[0]?.name ?? "",
      // Thinking levels come only from the catalog; no invented fallback.
      effortsFor: (model) => orderedEfforts(meta(model)?.reasoningLevels ?? []),
      defaultEffortFor: (model) => meta(model)?.defaultReasoningLevel ?? null,
      effortLabel: formatBubbleThinkingLevelLabel,
      fastFor: () => false,
      permissionModes: visible(BUBBLE_PERMISSION_MODE_OPTIONS),
      defaultPermission: "default",
      supportsPlan: true,
    };
  }
  // Claude: Default, official models, then enabled compatible providers.
  const config = options?.claude;
  const compatible = config?.compatible ?? [];
  const compatibleModels = new Set(compatible.map((c) => c.model));
  const configuredDefault = canonicalizeClaudeModel(config?.defaultModel);
  const official = config
    ? Array.from(
        new Set(
          buildClaudeModelOptions({ defaultModel: config.defaultModel, options: config.options })
            .map((v) => canonicalizeClaudeModel(v))
            .filter((v): v is string => Boolean(v))
            .filter((v) => isOfficialClaudeModel(v))
            .filter((v) => v === configuredDefault || !compatibleModels.has(v)),
        ),
      )
    : [];
  return {
    provider: "claude",
    models: [
      { value: "", label: "Default", description: "Do not override the default model" },
      ...official.map((v) => ({ value: v, label: formatClaudeModelLabel(v) })),
      ...compatible.map((c) => ({
        value: c.model,
        label: c.model,
        description: COMPATIBLE_PROVIDER_LABELS[c.id as keyof typeof COMPATIBLE_PROVIDER_LABELS] ?? c.id,
        compatibleProviderId: c.id,
      })),
    ],
    defaultModel: "",
    effortsFor: () => [...CLAUDE_REASONING_EFFORT_OPTIONS],
    defaultEffortFor: () => null,
    effortLabel: (e) => CLAUDE_REASONING_EFFORT_LABELS[e as keyof typeof CLAUDE_REASONING_EFFORT_LABELS] ?? e,
    fastFor: () => false,
    permissionModes: visible(CLAUDE_PERMISSION_MODE_OPTIONS),
    defaultPermission: "default",
    supportsPlan: true,
  };
}

/** Effective settings with defaults filled in, for labels and requests. */
export function resolveSettings(catalog: AgentCatalog, settings: RemoteTaskSettings) {
  const model = settings.model ?? catalog.defaultModel;
  const modelChoice =
    catalog.models.find((m) => m.value === model && (m.compatibleProviderId ?? null) === (settings.compatibleProviderId ?? null)) ??
    catalog.models.find((m) => m.value === model);
  const efforts = catalog.effortsFor(model);
  const effort = settings.effort && efforts.includes(settings.effort) ? settings.effort : catalog.defaultEffortFor(model);
  const permissionMode = catalog.permissionModes.some((p) => p.mode === settings.permissionMode)
    ? settings.permissionMode!
    : catalog.defaultPermission;
  return {
    model,
    modelLabel: modelChoice?.label ?? (model || "Default"),
    compatibleProviderId: modelChoice?.compatibleProviderId ?? null,
    efforts,
    effort,
    effortLabel: effort ? catalog.effortLabel(effort) : null,
    fastAvailable: catalog.fastFor(model),
    fast: catalog.fastFor(model) && settings.fast === true,
    permissionMode,
    permission: catalog.permissionModes.find((p) => p.mode === permissionMode),
    plan: catalog.supportsPlan && settings.plan === true,
  };
}

/** Request payload: only fields the user set, so the Mac keeps its defaults otherwise. */
export function toRequestSettings(catalog: AgentCatalog, settings: RemoteTaskSettings): RemoteTaskSettings {
  const r = resolveSettings(catalog, settings);
  return {
    ...(r.model ? { model: r.model } : {}),
    ...(r.compatibleProviderId ? { compatibleProviderId: r.compatibleProviderId } : {}),
    ...(settings.effort && r.effort ? { effort: r.effort } : {}),
    ...(r.fastAvailable ? { fast: r.fast } : {}),
    permissionMode: r.permissionMode,
    plan: r.plan,
  };
}
