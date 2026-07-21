import type { ProviderSendTurnInput } from './provider/types';

/**
 * The per-turn option envelope a warm-runner dispatch carries — every
 * provider's per-turn options, unconditionally. Provider-conditional
 * assembly at the dispatch site is how grok's permission-mode switch got
 * silently dropped (the codex/kimi/qoder branches existed, grok's didn't);
 * fields for non-active providers are `undefined` by construction of the
 * dispatch site's provider-gated `next*` locals, and the per-field
 * `sendOptions?.x ?? options.x` merge in agent-loop treats them as absent.
 *
 * Typed as a Pick of ProviderSendTurnInput (single source of truth for the
 * key names); the builder's internal mapped type makes every key REQUIRED,
 * so dropping a field here is a compile error. One named-object parameter,
 * never positional args: several of these option types are identical string
 * unions (KimiPermissionMode ≡ GrokPermissionMode), so transposed positional
 * arguments would compile clean and cross-wire providers.
 */
export type WarmSendOptions = Pick<
  ProviderSendTurnInput,
  | 'codexExecutionMode'
  | 'codexPermissionMode'
  | 'codexReasoningEffort'
  | 'codexFastMode'
  | 'kimiPermissionMode'
  | 'kimiThinking'
  | 'grokPermissionMode'
  | 'grokReasoningEffort'
  | 'opencodePermissionMode'
  | 'qoderPermissionMode'
>;

export function buildWarmSendOptions(next: WarmSendOptions): WarmSendOptions {
  const envelope: { [K in keyof Required<WarmSendOptions>]: WarmSendOptions[K] } = {
    codexExecutionMode: next.codexExecutionMode,
    codexPermissionMode: next.codexPermissionMode,
    codexReasoningEffort: next.codexReasoningEffort || undefined,
    codexFastMode: next.codexFastMode,
    kimiPermissionMode: next.kimiPermissionMode,
    kimiThinking: next.kimiThinking,
    grokPermissionMode: next.grokPermissionMode,
    grokReasoningEffort: next.grokReasoningEffort,
    opencodePermissionMode: next.opencodePermissionMode,
    qoderPermissionMode: next.qoderPermissionMode,
  };
  return envelope;
}
