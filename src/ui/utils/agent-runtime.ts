import type { AgentProfile } from '../types';
import type {
  RoutedAgentPublicProfile,
  RoutedAgentRuntimePayload,
} from '../../shared/types';
import type { buildAegisReferencePayload } from './aegis-composer';
import type { buildCodexReferencePayload } from './codex-composer';

export function buildAgentEffectivePrompt(
  prompt: string,
  profile: AgentProfile | null | undefined,
  context?: {
    mode: 'dm' | 'project';
    cwd?: string | null;
    channelId?: string | null;
    handle?: string | null;
    assignmentSource?: 'mention' | 'assignment';
  },
  options?: { includeIdentity?: boolean }
): string {
  if (!profile) {
    return prompt;
  }
  const includeIdentity = options?.includeIdentity !== false;

  const contextLines =
    context?.mode === 'project'
      ? [
          context.handle
            ? `${context.assignmentSource === 'assignment' ? 'Assigned agent' : 'Mention'}: @${context.handle}`
            : '',
          context.channelId ? `Project channel: #${context.channelId}` : '',
          context.cwd ? `Project directory: ${context.cwd}` : '',
          context.assignmentSource === 'assignment'
            ? 'This is a project channel task assignment. Use the project context and answer as the assigned agent.'
            : 'This is a project channel conversation. Use the project context and answer as the mentioned agent.',
        ]
      : [
          'This is a direct message conversation. Do not assume any project working directory or project context unless the user explicitly provides it.',
        ];

  const lines = [
    includeIdentity ? `You are ${profile.name.trim() || 'this agent'}.` : '',
    includeIdentity && profile.role.trim() ? `Role: ${profile.role.trim()}` : '',
    includeIdentity && profile.description.trim() ? `Profile: ${profile.description.trim()}` : '',
    includeIdentity && profile.instructions.trim() ? `Instructions:\n${profile.instructions.trim()}` : '',
    ...contextLines,
    `User message:\n${prompt}`,
  ].filter(Boolean);

  return lines.join('\n\n');
}

export function getAgentRuntime(profile: AgentProfile | null | undefined) {
  if (!profile) {
    return null;
  }

  const identity = `${profile.id} ${profile.name} ${profile.role}`.toLowerCase();
  const isReviewer =
    identity.includes('reviewer') ||
    identity.includes('review') ||
    identity.includes('评审') ||
    identity.includes('审查') ||
    identity.includes('审阅');
  const effectivePermissionPolicy =
    profile.permissionPolicy === 'readOnly' && isReviewer ? 'ask' : profile.permissionPolicy;
  const isReadOnly = effectivePermissionPolicy === 'readOnly';
  const isFullAccess = effectivePermissionPolicy === 'fullAccess';

  return {
    provider: profile.provider,
    model: profile.model?.trim() || null,
    compatibleProviderId: profile.provider === 'claude' ? profile.compatibleProviderId : undefined,
    claudeReasoningEffort: profile.provider === 'claude' ? profile.reasoningEffort : undefined,
    codexReasoningEffort:
      profile.provider === 'codex' && profile.reasoningEffort !== 'max'
        ? profile.reasoningEffort
        : undefined,
    claudeAccessMode: isFullAccess ? 'fullAccess' as const : 'default' as const,
    claudeExecutionMode: isReadOnly ? 'plan' as const : 'execute' as const,
    codexExecutionMode: isReadOnly ? 'plan' as const : 'execute' as const,
    codexPermissionMode: isFullAccess ? 'fullAccess' as const : 'defaultPermissions' as const,
    opencodePermissionMode: isFullAccess ? 'fullAccess' as const : 'defaultPermissions' as const,
    aegisPermissionMode: isReadOnly
      ? 'readOnly' as const
      : isFullAccess
        ? 'fullAccess' as const
        : 'defaultPermissions' as const,
    aegisReasoningEffort:
      profile.provider === 'aegis' && (profile.reasoningEffort === 'high' || profile.reasoningEffort === 'max')
        ? profile.reasoningEffort
        : undefined,
  };
}

function canAgentDelegate(profile: AgentProfile): boolean {
  const identity = `${profile.name} ${profile.role}`.toLowerCase();
  return (
    profile.canDelegate === true ||
    identity.includes('coordinator') ||
    identity.includes('协调') ||
    identity.includes('调度')
  );
}

export function toPublicAgentProfile(profile: AgentProfile): RoutedAgentPublicProfile {
  return {
    id: profile.id,
    name: profile.name.trim() || 'Agent',
    role: profile.role.trim() || 'Agent',
    description: profile.description.trim() || undefined,
    canDelegate: canAgentDelegate(profile),
  };
}

export function buildAgentRuntimePayload(
  profile: AgentProfile,
  codexReferences: ReturnType<typeof buildCodexReferencePayload>,
  aegisReferences: ReturnType<typeof buildAegisReferencePayload>
): RoutedAgentRuntimePayload | null {
  const runtime = getAgentRuntime(profile);
  if (!runtime) {
    return null;
  }

  return {
    routedAgentId: profile.id,
    agent: toPublicAgentProfile(profile),
    instructions: profile.instructions.trim() || undefined,
    provider: runtime.provider,
    model: runtime.model || undefined,
    compatibleProviderId:
      runtime.provider === 'claude' ? runtime.compatibleProviderId : undefined,
    claudeAccessMode: runtime.provider === 'claude' ? runtime.claudeAccessMode : undefined,
    claudeExecutionMode: runtime.provider === 'claude' ? runtime.claudeExecutionMode : undefined,
    claudeReasoningEffort:
      runtime.provider === 'claude' ? runtime.claudeReasoningEffort : undefined,
    codexExecutionMode: runtime.provider === 'codex' ? runtime.codexExecutionMode : undefined,
    codexPermissionMode: runtime.provider === 'codex' ? runtime.codexPermissionMode : undefined,
    codexReasoningEffort: runtime.provider === 'codex' ? runtime.codexReasoningEffort : undefined,
    codexSkills: runtime.provider === 'codex' ? codexReferences.codexSkills : undefined,
    codexMentions: runtime.provider === 'codex' ? codexReferences.codexMentions : undefined,
    aegisSkills: runtime.provider === 'aegis' ? aegisReferences.aegisSkills : undefined,
    aegisMentions: runtime.provider === 'aegis' ? aegisReferences.aegisMentions : undefined,
    opencodePermissionMode:
      runtime.provider === 'opencode' ? runtime.opencodePermissionMode : undefined,
    aegisPermissionMode:
      runtime.provider === 'aegis' ? runtime.aegisPermissionMode : undefined,
    aegisReasoningEffort:
      runtime.provider === 'aegis' ? runtime.aegisReasoningEffort : undefined,
  };
}
