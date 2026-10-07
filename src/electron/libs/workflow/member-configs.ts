// Member configurations the Host offers to the Planner (plan §3.2, §6.2).
// Every integrated provider can join a workflow; which roles it may take
// depends on how the Host can hold it to them. Declarations not yet backed by
// a passing conformance run are marked `verified: false` and shown as such.

import type { AgentProvider, SessionStartPayload } from '../../../shared/types';
import type { MemberRole } from '../../../workflow-engine/spec/workflow-spec';
import type { MemberConfig } from '../../../workflow-engine/validate/spec-validator';
import { CURRENT_SESSION_AGENT } from '../../../shared/workflow';

export type ReadOnlyMechanism = 'toolAllowlist' | 'readOnlySandbox' | 'permissionGatedWrites' | 'confinedSandbox';

export type ProviderWorkflowDeclaration = {
  provider: AgentProvider;
  label: string;
  /** How read-only roles are enforced; null means the provider can only implement. */
  readOnly: ReadOnlyMechanism | null;
  /** Payload fields that put a read-only member into the mode the mechanism relies on. */
  readOnlyPayload: Partial<SessionStartPayload>;
  /** Which payload field carries the implementer's permission mode. */
  permissionField: keyof SessionStartPayload | null;
  structuredOutput: 'native' | 'json-tail';
  resumeTurns: boolean;
  /**
   * Set once the provider's read-only conformance run has passed on a real
   * runtime (scripts/tests/workflow-conformance-electron.mjs). 2026-10-05:
   * claude, codex, kimi (plan mode), grok, devin and bubble (plan mode) passed;
   * qoder and deepseek could not run (account limits) and opencode could not
   * start (SDK/CLI version mismatch).
   */
  verified: boolean;
};

export const PROVIDER_WORKFLOW_DECLARATIONS: ProviderWorkflowDeclaration[] = [
  {
    provider: 'claude',
    label: 'Claude',
    readOnly: 'toolAllowlist',
    readOnlyPayload: { claudeAccessMode: 'default', claudeExecutionMode: 'execute' },
    permissionField: 'claudeAccessMode',
    structuredOutput: 'json-tail', // native outputFormat/outputSchema not wired for members yet
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'codex',
    label: 'Codex',
    readOnly: 'readOnlySandbox',
    readOnlyPayload: { codexPermissionMode: 'defaultPermissions', codexExecutionMode: 'execute' },
    permissionField: 'codexPermissionMode',
    structuredOutput: 'json-tail', // native outputFormat/outputSchema not wired for members yet
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'kimi',
    label: 'Kimi',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { kimiPermissionMode: 'plan' },
    permissionField: 'kimiPermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'opencode',
    label: 'OpenCode',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { opencodePermissionMode: 'defaultPermissions' },
    permissionField: 'opencodePermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    provider: 'grok',
    label: 'Grok',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { grokPermissionMode: 'default' },
    permissionField: 'grokPermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'devin',
    label: 'Devin',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { devinPermissionMode: 'ask' },
    permissionField: 'devinPermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    provider: 'qoder',
    label: 'Qoder',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { qoderPermissionMode: 'default' },
    permissionField: 'qoderPermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    provider: 'bubble',
    label: 'Bubble',
    readOnly: 'permissionGatedWrites',
    readOnlyPayload: { bubblePermissionMode: 'plan' },
    permissionField: 'bubblePermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: true,
  },
  {
    // The DeepSeek harness never emits permission requests; workspace-write
    // confines bash/fs to the session cwd, which for read-only roles is the
    // disposable review copy.
    provider: 'deepseek',
    label: 'DeepSeek',
    readOnly: 'confinedSandbox',
    readOnlyPayload: { deepseekPermissionMode: 'workspace-write' },
    permissionField: 'deepseekPermissionMode',
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
  {
    // No permission requests and no sandbox: nothing can hold Pi to read-only.
    provider: 'pi',
    label: 'Pi',
    readOnly: null,
    readOnlyPayload: {},
    permissionField: null,
    structuredOutput: 'json-tail',
    resumeTurns: true,
    verified: false,
  },
];

export function declarationFor(provider: string): ProviderWorkflowDeclaration | undefined {
  return PROVIDER_WORKFLOW_DECLARATIONS.find((d) => d.provider === provider);
}

export function rolesFor(declaration: ProviderWorkflowDeclaration): MemberRole[] {
  return declaration.readOnly ? ['implementer', 'reviewer', 'advisor'] : ['implementer'];
}

export function degradedFor(declaration: ProviderWorkflowDeclaration): string[] {
  const degraded: string[] = [];
  if (declaration.structuredOutput !== 'native') degraded.push('structuredOutput');
  if (!declaration.resumeTurns) degraded.push('resumeTurns');
  if (!declaration.verified) degraded.push('unverified');
  return degraded;
}

/**
 * Configurations for the providers available on this machine, plus the chat
 * session that started the run when there is one. That session keeps its own
 * permission mode and is never held read-only, so it may only implement.
 */
export function buildMemberConfigs(available: AgentProvider[], parentProvider?: string | null): MemberConfig[] {
  const configs: MemberConfig[] = PROVIDER_WORKFLOW_DECLARATIONS.filter((d) => available.includes(d.provider)).map((d) => ({
    name: d.provider,
    provider: d.provider,
    roles: rolesFor(d),
    models: [],
    degraded: degradedFor(d),
  }));
  const parent = parentProvider ? declarationFor(parentProvider) : undefined;
  if (parent) {
    configs.unshift({
      name: CURRENT_SESSION_AGENT,
      provider: parent.provider,
      roles: ['implementer'],
      models: [],
      degraded: degradedFor(parent).filter((d) => d !== 'unverified'),
    });
  }
  return configs;
}

/** Declaration behind a member's agent name ("current" resolves to the parent session's provider). */
export function declarationForAgent(agent: string, parentProvider?: string | null): ProviderWorkflowDeclaration | undefined {
  return agent === CURRENT_SESSION_AGENT ? (parentProvider ? declarationFor(parentProvider) : undefined) : declarationFor(agent);
}

/** Payload fields for a member session of this role (plan §3.2, §6.3). */
export function memberSessionPayload(
  declaration: ProviderWorkflowDeclaration,
  role: MemberRole | 'planner',
  permissionModes: Record<string, string>
): { payload: Partial<SessionStartPayload>; permissionMode: string | null; permissionDefault: boolean } {
  if (role !== 'implementer') {
    return { payload: { ...declaration.readOnlyPayload }, permissionMode: null, permissionDefault: false };
  }
  const mode = permissionModes[declaration.provider];
  if (!declaration.permissionField || !mode) {
    return { payload: {}, permissionMode: null, permissionDefault: true };
  }
  return {
    payload: { [declaration.permissionField]: mode } as Partial<SessionStartPayload>,
    permissionMode: mode,
    permissionDefault: false,
  };
}
