import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Plus, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type {
  Attachment,
  AgentProfile,
} from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ProjectAgentMentionMenu } from './ProjectAgentMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { CodexContextIndicator } from './CodexContextIndicator';
import { AgentAvatar } from './AgentAvatar';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { useProjectAgentMentions } from '../hooks/useProjectAgentMentions';
import {
  DEFAULT_WORKSPACE_CHANNEL_ID,
  type RoutedAgentPublicProfile,
  type RoutedAgentRuntimePayload,
  type RoutedAgentTurnPayload,
} from '../../shared/types';
import { insertProjectFileMention } from '../utils/project-file-mentions';
import { buildPromptWithProjectFileMentions } from '../utils/project-file-mention-context';
import {
  LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD,
  maybeConvertLongPromptToAttachment,
} from '../utils/long-prompt-attachment';
import { buildCodexReferencePayload } from '../utils/codex-composer';
import { buildAegisReferencePayload } from '../utils/aegis-composer';
import { getLatestCodexContextSnapshot } from '../utils/context-usage';
import {
  getAgentMentionHandle,
  getAgentMentionHandles,
  getAgentMentionAliases,
  getProjectAgentProfiles,
  insertProjectAgentMention,
  resolveProjectAgentMentionRoutes,
} from '../utils/agent-mentions';

function isImeComposingEvent(
  event: React.KeyboardEvent,
  isComposingRef: React.MutableRefObject<boolean>
): boolean {
  return (
    isComposingRef.current ||
    event.nativeEvent.isComposing === true ||
    (event.nativeEvent as KeyboardEvent).keyCode === 229
  );
}

function buildAgentEffectivePrompt(
  prompt: string,
  profile: AgentProfile | null | undefined,
  context?: {
    mode: 'dm' | 'project';
    cwd?: string | null;
    channelId?: string | null;
    handle?: string | null;
    assignmentSource?: 'mention' | 'assignment';
  }
): string {
  if (!profile) {
    return prompt;
  }

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
    `You are ${profile.name.trim() || 'this agent'}.`,
    profile.role.trim() ? `Role: ${profile.role.trim()}` : '',
    profile.description.trim() ? `Profile: ${profile.description.trim()}` : '',
    profile.instructions.trim() ? `Instructions:\n${profile.instructions.trim()}` : '',
    ...contextLines,
    `User message:\n${prompt}`,
  ].filter(Boolean);

  return lines.join('\n\n');
}

function getAgentRuntime(profile: AgentProfile | null | undefined) {
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

function toPublicAgentProfile(profile: AgentProfile): RoutedAgentPublicProfile {
  return {
    id: profile.id,
    name: profile.name.trim() || 'Agent',
    role: profile.role.trim() || 'Agent',
    description: profile.description.trim() || undefined,
    canDelegate: canAgentDelegate(profile),
  };
}

function buildAgentRuntimePayload(
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

function providerLabel(provider: AgentProfile['provider']): string {
  if (provider === 'aegis') return 'Aegis';
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

function ProjectAgentPicker({
  profiles,
  selectedProfile,
  disabled,
  onSelect,
}: {
  profiles: AgentProfile[];
  selectedProfile: AgentProfile | null;
  disabled: boolean;
  onSelect: (profileId: string) => void;
}) {
  if (profiles.length === 0) {
    return null;
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 min-w-0 max-w-[220px] items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_76%,var(--accent)_24%)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          title={selectedProfile ? `Send with ${selectedProfile.name.trim() || 'Agent'}` : 'Select agent'}
          aria-label="Select project agent"
        >
          {selectedProfile ? (
            <AgentAvatar profile={selectedProfile} size="sm" decorative />
          ) : null}
          <span className="min-w-0 truncate">
            {selectedProfile?.name.trim() || 'Select agent'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          className="z-50 w-[280px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          {profiles.map((profile) => {
            const selected = selectedProfile?.id === profile.id;
            return (
              <DropdownMenu.Item
                key={profile.id}
                onSelect={() => onSelect(profile.id)}
                className="flex cursor-default items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-[var(--bg-tertiary)]"
              >
                <AgentAvatar profile={profile} size="sm" decorative />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {profile.name.trim() || 'Agent'}
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    @{getAgentMentionHandle(profile)} · {profile.role.trim() || 'Agent'} · {providerLabel(profile.provider)}
                  </div>
                </div>
                {selected ? <Check className="h-4 w-4 text-[var(--accent)]" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function PromptInput({
  sessionId,
  approvalPending = false,
  approvalPanel,
}: {
  sessionId?: string | null;
  approvalPending?: boolean;
  approvalPanel?: ReactNode;
} = {}) {
  const {
    activeSessionId,
    sessions,
    agentProfiles,
    projectAgentRostersByProject,
    selectedProjectAgentByProject,
    setSelectedProjectAgentForProject,
    activeChannelByProject,
    pendingStart,
    setShowNewSession,
    setPendingStart,
    promptLibraryInsertRequest,
    consumePromptLibraryInsert,
    pendingChatInjection,
    consumeChatInjection,
  } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const targetSessionId = sessionId ?? activeSessionId;

  const activeSession = targetSessionId ? sessions[targetSessionId] : null;
  const codexContextSnapshot = useMemo(
    () =>
      activeSession?.provider === 'codex'
        ? getLatestCodexContextSnapshot(activeSession.messages)
        : null,
    [activeSession?.messages, activeSession?.provider]
  );
  const activeProjectKey =
    activeSession?.scope === 'dm' ? null : activeSession?.cwd?.trim() || null;
  const directAgentProfile =
    activeSession?.scope === 'dm' && activeSession.agentId
      ? agentProfiles[activeSession.agentId] || null
      : null;
  const projectAgentProfiles = useMemo(
    () =>
      activeSession?.scope === 'dm'
        ? []
        : getProjectAgentProfiles({
            agentProfiles,
            projectAgentRostersByProject,
            cwd: activeSession?.cwd,
          }),
    [activeSession?.cwd, activeSession?.scope, agentProfiles, projectAgentRostersByProject]
  );
  const projectAgentRoutes = useMemo(
    () =>
      activeSession?.scope === 'dm'
        ? null
        : resolveProjectAgentMentionRoutes(prompt, projectAgentProfiles),
    [activeSession?.scope, projectAgentProfiles, prompt]
  );
  const activeProjectAgentRoutes = useMemo(
    () =>
      (projectAgentRoutes || []).map((route) => ({
        profile: route.profile,
        handle: route.handle,
        assignmentSource: 'mention' as const,
      })),
    [projectAgentRoutes]
  );
  const selectedProjectAgentProfile = useMemo(() => {
    if (!activeProjectKey || projectAgentProfiles.length === 0) {
      return null;
    }

    const persistedProfileId = selectedProjectAgentByProject[activeProjectKey];
    return (
      projectAgentProfiles.find((profile) => profile.id === persistedProfileId) ||
      projectAgentProfiles[0] ||
      null
    );
  }, [activeProjectKey, projectAgentProfiles, selectedProjectAgentByProject]);
  const selectedProjectAgentRoute = useMemo(
    () =>
      selectedProjectAgentProfile
        ? {
            profile: selectedProjectAgentProfile,
            handle: getAgentMentionHandle(selectedProjectAgentProfile),
            assignmentSource: 'assignment' as const,
          }
        : null,
    [selectedProjectAgentProfile]
  );
  const effectiveProjectAgentRoutes =
    activeProjectAgentRoutes.length > 0
      ? activeProjectAgentRoutes
      : selectedProjectAgentRoute
        ? [selectedProjectAgentRoute]
        : [];
  const activeProjectAgentRoute = effectiveProjectAgentRoutes[0] || null;
  const runtimeAgentProfile = directAgentProfile || activeProjectAgentRoute?.profile || null;
  const directAgentRuntime = getAgentRuntime(directAgentProfile);
  const projectAgentRuntime = getAgentRuntime(activeProjectAgentRoute?.profile || null);
  const agentRuntime = directAgentRuntime || projectAgentRuntime;
  const runtimeProvider = agentRuntime?.provider || 'claude';
  const activeComposerAgentProfiles = directAgentProfile
    ? [directAgentProfile]
    : effectiveProjectAgentRoutes.map((route) => route.profile);
  const activeComposerAgentProfile = activeComposerAgentProfiles[0] || null;
  const enabledAgentCount = useMemo(
    () => Object.values(agentProfiles).filter((profile) => profile.enabled).length,
    [agentProfiles]
  );
  const isRunning = activeSession?.status === 'running';
  const isBusy = isRunning || pendingStart || approvalPending;
  const runtimeClaudeModel = runtimeProvider === 'claude' ? agentRuntime?.model || null : null;
  const runtimeClaudeCompatibleProviderId =
    runtimeProvider === 'claude' ? agentRuntime?.compatibleProviderId : undefined;
  const runtimeCodexModel = runtimeProvider === 'codex' ? agentRuntime?.model || null : null;
  const runtimeOpencodeModel = runtimeProvider === 'opencode' ? agentRuntime?.model || null : null;
  const runtimeAegisModel = runtimeProvider === 'aegis' ? agentRuntime?.model || null : null;
  const runtimeClaudeAccessMode = agentRuntime?.claudeAccessMode;
  const runtimeClaudeExecutionMode = agentRuntime?.claudeExecutionMode;
  const runtimeClaudeReasoningEffort = agentRuntime?.claudeReasoningEffort;
  const runtimeCodexExecutionMode = agentRuntime?.codexExecutionMode;
  const runtimeCodexPermissionMode = agentRuntime?.codexPermissionMode;
  const runtimeCodexReasoningEffort = agentRuntime?.codexReasoningEffort;
  const runtimeOpencodePermissionMode = agentRuntime?.opencodePermissionMode;
  const runtimeAegisPermissionMode = agentRuntime?.aegisPermissionMode;
  const resetComposer = useCallback(() => {
    setPrompt('');
    setCursorIndex(0);
    setAttachments([]);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setCursorIndex(0);
    });
  }, []);

  const handleAutoSubmitClaudeCommand = (nextPrompt: string) => {
    if (!runtimeAgentProfile || !agentRuntime) {
      setPrompt(nextPrompt);
      return;
    }
    if (!targetSessionId || !activeSession || activeSession.isDraft) {
      setPrompt(nextPrompt);
      return;
    }

    const effectivePrompt = buildAgentEffectivePrompt(
      nextPrompt,
      runtimeAgentProfile,
      directAgentProfile
        ? { mode: 'dm' }
        : activeProjectAgentRoute
          ? {
              mode: 'project',
              cwd: activeSession.cwd,
              channelId: activeSession.channelId,
              handle: activeProjectAgentRoute.handle,
              assignmentSource: activeProjectAgentRoute.assignmentSource,
            }
          : undefined
    );
    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId: targetSessionId,
        prompt: nextPrompt,
        effectivePrompt,
        provider: runtimeProvider,
        model:
          runtimeProvider === 'claude'
            ? runtimeClaudeModel || undefined
            : runtimeProvider === 'codex'
              ? runtimeCodexModel || undefined
              : runtimeProvider === 'opencode'
                ? runtimeOpencodeModel || undefined
                : runtimeProvider === 'aegis'
                  ? runtimeAegisModel || undefined
                : undefined,
        compatibleProviderId:
          runtimeProvider === 'claude' ? runtimeClaudeCompatibleProviderId : undefined,
        claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
        claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
        claudeReasoningEffort: runtimeProvider === 'claude' ? runtimeClaudeReasoningEffort : undefined,
        codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
        codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
        codexReasoningEffort: runtimeProvider === 'codex' ? runtimeCodexReasoningEffort : undefined,
        opencodePermissionMode:
          runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
        aegisPermissionMode:
          runtimeProvider === 'aegis' ? runtimeAegisPermissionMode : undefined,
        aegisReasoningEffort:
          runtimeProvider === 'aegis' ? agentRuntime?.aegisReasoningEffort : undefined,
        routedAgentId: runtimeAgentProfile?.id || undefined,
      },
    });
    resetComposer();
  };
  const skillAutocomplete = useComposerCapabilityMenu({
    enabled: Boolean(activeSession),
    enableSkills: true,
    provider: runtimeProvider,
    prompt,
    cursorIndex,
    projectPath: activeSession?.cwd,
    sessionMessages: activeSession?.messages || [],
    setPrompt,
    setCursorIndex,
    onAutoSubmitCommand: handleAutoSubmitClaudeCommand,
  });
  const projectAgentMentions = useProjectAgentMentions({
    profiles: projectAgentProfiles,
    prompt: skillAutocomplete.displayPrompt,
    cursorIndex,
  });
  const projectFileMentions = useProjectFileMentions({
    cwd: activeSession?.cwd,
    prompt: skillAutocomplete.displayPrompt,
    cursorIndex,
  });
  const projectAgentMentionHandles = useMemo(
    () => getAgentMentionHandles(projectAgentProfiles),
    [projectAgentProfiles]
  );
  const projectAgentMentionLabels = useMemo(
    () =>
      Object.fromEntries(
        projectAgentProfiles.flatMap((profile) =>
          getAgentMentionAliases(profile).map((handle) => [
            handle,
            profile.name.trim() || 'Agent',
          ])
        )
      ),
    [projectAgentProfiles]
  );
  const projectAgentMentionActive =
    projectAgentMentions.hasMentionQuery && projectAgentMentions.suggestions.length > 0;

  useEffect(() => {
    if (!promptLibraryInsertRequest) {
      return;
    }

    setPrompt((current) => {
      if (promptLibraryInsertRequest.mode === 'replace' || !current.trim()) {
        return promptLibraryInsertRequest.content;
      }

      return `${current.trimEnd()}\n\n${promptLibraryInsertRequest.content}`;
    });
    window.requestAnimationFrame(() => editorRef.current?.focus());
    consumePromptLibraryInsert(promptLibraryInsertRequest.nonce);
  }, [consumePromptLibraryInsert, promptLibraryInsertRequest]);

  useEffect(() => {
    if (!pendingChatInjection) {
      return;
    }
    if (pendingChatInjection.sessionId && pendingChatInjection.sessionId !== targetSessionId) {
      return;
    }
    const injection = pendingChatInjection;
    if (injection.text) {
      setPrompt((current) => {
        if (injection.mode === 'replace' || !current.trim()) {
          return injection.text ?? '';
        }
        return `${current.trimEnd()}\n\n${injection.text}`;
      });
    }
    if (injection.attachments && injection.attachments.length > 0) {
      setAttachments((prev) => {
        const existing = new Set(prev.map((item) => item.id));
        const additions = (injection.attachments ?? []).filter((a) => !existing.has(a.id));
        return [...prev, ...additions];
      });
    }
    window.requestAnimationFrame(() => editorRef.current?.focus());
    consumeChatInjection(injection.nonce);
  }, [consumeChatInjection, pendingChatInjection, targetSessionId]);

  const composerBlocker = useMemo(() => {
    if (!activeSession) {
      return null;
    }

    if (enabledAgentCount === 0) {
      return {
        title: 'No agents configured',
        description: 'Set up a local agent profile before sending messages.',
      };
    }

    if (activeSession.scope === 'dm') {
      if (!directAgentProfile) {
        return {
          title: 'Agent unavailable',
          description: 'Set up a local agent profile before sending messages.',
        };
      }
      return null;
    }

    if (projectAgentProfiles.length === 0) {
      return {
        title: 'No agents assigned to this project',
        description: 'Create an agent profile or add one to this project.',
      };
    }

    if (effectiveProjectAgentRoutes.length === 0) {
      return {
        title: 'Select an agent to send',
        description: 'Pick a project agent before sending in this channel.',
      };
    }

    return null;
  }, [
    effectiveProjectAgentRoutes.length,
    activeSession,
    directAgentProfile,
    enabledAgentCount,
    projectAgentProfiles.length,
  ]);

  const buildDispatchPrompt = async (): Promise<string | null> => {
    const trimmedPrompt = prompt.trim();

    const selectedSkill = skillAutocomplete.selectedSkill;
    if (selectedSkill) {
      const selectedSkillRemainder = skillAutocomplete.selectedSkillRemainder;
      const expandedPrompt =
        runtimeProvider === 'codex'
          ? selectedSkillRemainder.trim()
          : runtimeProvider === 'claude'
            ? trimmedPrompt
            : await (async () => {
                const result = await window.electron.expandClaudeSkillPrompt(
                  selectedSkill.path,
                  selectedSkill.name,
                  selectedSkillRemainder
                );

                if (!result.ok || !result.prompt) {
                  toast.error(result.message || `Failed to expand /${selectedSkill.name}.`);
                  return null;
                }

                return result.prompt.trim();
              })();

      if (expandedPrompt === null) {
        return null;
      }

      return buildPromptWithProjectFileMentions({
        cwd: activeSession?.cwd || null,
        prompt: expandedPrompt,
        ignoredMentionPaths: projectAgentMentionHandles,
      });
    }

    return buildPromptWithProjectFileMentions({
      cwd: activeSession?.cwd || null,
      prompt: trimmedPrompt,
      ignoredMentionPaths: projectAgentMentionHandles,
    });
  };

  const autoConvertComposerTextToAttachment = useCallback(async (
    value: string,
    nextCursorIndex: number
  ): Promise<boolean> => {
    if (isComposingRef.current) {
      skillAutocomplete.setDisplayPrompt(value);
      setCursorIndex(nextCursorIndex);
      return false;
    }

    if (value.trim().length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) {
      skillAutocomplete.setDisplayPrompt(value);
      setCursorIndex(nextCursorIndex);
      return false;
    }

    const promptWithAttachment = await maybeConvertLongPromptToAttachment({
      cwd: activeSession?.cwd || null,
      prompt: value,
      attachments,
    });

    if (!promptWithAttachment.converted) {
      skillAutocomplete.setDisplayPrompt(value);
      setCursorIndex(nextCursorIndex);
      if (promptWithAttachment.reason === 'attachment_create_failed') {
        toast.error('Failed to convert the long message into an attachment.');
      }
      return false;
    }

    setAttachments(promptWithAttachment.attachments);
    skillAutocomplete.setDisplayPrompt('');
    setCursorIndex(0);
    window.requestAnimationFrame(() => editorRef.current?.focus());
    return true;
  }, [activeSession?.cwd, attachments, skillAutocomplete]);

  const handleSend = async () => {
    if (!prompt.trim() && attachments.length === 0) return;
    if (composerBlocker || !runtimeAgentProfile || !agentRuntime) {
      toast.error(
        composerBlocker
          ? `${composerBlocker.title}: ${composerBlocker.description}`
          : 'Select an agent before sending.'
      );
      return;
    }

    const displayPrompt = prompt.trim();
    const normalizedPrompt = await buildDispatchPrompt();
    if (normalizedPrompt === null) {
      return;
    }
    const promptWithAttachment = await maybeConvertLongPromptToAttachment({
      cwd: activeSession?.cwd || null,
      prompt: displayPrompt,
      attachments,
    });
    const outgoingPrompt = promptWithAttachment.converted ? promptWithAttachment.prompt : displayPrompt;
    const rawOutgoingEffectivePrompt = promptWithAttachment.converted
      ? promptWithAttachment.prompt
      : normalizedPrompt;
    const outgoingEffectivePrompt = buildAgentEffectivePrompt(
      rawOutgoingEffectivePrompt,
      runtimeAgentProfile,
      directAgentProfile
        ? { mode: 'dm' }
        : activeProjectAgentRoute
          ? {
              mode: 'project',
              cwd: activeSession?.cwd,
              channelId: activeSession?.channelId,
              handle: activeProjectAgentRoute.handle,
              assignmentSource: activeProjectAgentRoute.assignmentSource,
            }
          : undefined
    );
    const outgoingAttachments = promptWithAttachment.attachments;
    const codexReferences = buildCodexReferencePayload(skillAutocomplete.selectedSkill);
    const aegisReferences = buildAegisReferencePayload(skillAutocomplete.selectedSkill);
    const projectAgentRuntimePayloads =
      !directAgentProfile
        ? projectAgentProfiles
            .map((profile) => buildAgentRuntimePayload(profile, codexReferences, aegisReferences))
            .filter((turn): turn is RoutedAgentRuntimePayload => Boolean(turn))
        : undefined;
    const projectPublicAgents =
      !directAgentProfile ? projectAgentProfiles.map(toPublicAgentProfile) : undefined;
    const projectRoutedAgentTurns: RoutedAgentTurnPayload[] | undefined =
      !directAgentProfile && effectiveProjectAgentRoutes.length > 0
        ? effectiveProjectAgentRoutes
            .map((route): RoutedAgentTurnPayload | null => {
              const routeRuntime = buildAgentRuntimePayload(route.profile, codexReferences, aegisReferences);
              if (!routeRuntime) {
                return null;
              }

              const routeEffectivePrompt = buildAgentEffectivePrompt(
                rawOutgoingEffectivePrompt,
                route.profile,
                {
                  mode: 'project',
                  cwd: activeSession?.cwd,
                  channelId: activeSession?.channelId,
                  handle: route.handle,
                  assignmentSource: route.assignmentSource,
                }
              );

              return {
                ...routeRuntime,
                effectivePrompt: routeEffectivePrompt,
                projectAgents: projectPublicAgents,
                availableAgentTurns: projectAgentRuntimePayloads,
                delegationKind: 'user',
              };
            })
            .filter((turn): turn is RoutedAgentTurnPayload => Boolean(turn))
        : undefined;
    if (promptWithAttachment.reason === 'attachment_create_failed') {
      toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
    }

    if (targetSessionId && activeSession?.isDraft) {
      const isDirectMessageDraft = activeSession.scope === 'dm';
      if (!isDirectMessageDraft && !activeSession.cwd?.trim()) {
        toast.error('Select a project folder before starting a task.');
        return;
      }

      setPendingStart(true);
      useAppStore.setState({ pendingDraftSessionId: targetSessionId });
      const projectKey = isDirectMessageDraft ? '__dm__' : (activeSession.cwd || '').trim() || '__no_project__';
      const channelId =
        activeSession.channelId ||
        activeChannelByProject[projectKey] ||
        DEFAULT_WORKSPACE_CHANNEL_ID;
      sendEvent({
        type: 'session.start',
        payload: {
          title: activeSession.title || 'New Chat',
          prompt: outgoingPrompt,
          effectivePrompt: outgoingEffectivePrompt,
          cwd: isDirectMessageDraft ? undefined : activeSession.cwd,
          scope: isDirectMessageDraft ? 'dm' : 'project',
          agentId: isDirectMessageDraft ? activeSession.agentId || undefined : undefined,
          channelId: isDirectMessageDraft ? DEFAULT_WORKSPACE_CHANNEL_ID : channelId,
          attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
          provider: runtimeProvider,
          model:
            runtimeProvider === 'claude'
              ? runtimeClaudeModel || undefined
              : runtimeProvider === 'codex'
                ? runtimeCodexModel || undefined
                : runtimeProvider === 'opencode'
                  ? runtimeOpencodeModel || undefined
                  : runtimeProvider === 'aegis'
                    ? runtimeAegisModel || undefined
                  : undefined,
          compatibleProviderId:
            runtimeProvider === 'claude' ? runtimeClaudeCompatibleProviderId : undefined,
          claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
          claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
          claudeReasoningEffort: runtimeProvider === 'claude' ? runtimeClaudeReasoningEffort : undefined,
          codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
          codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
          codexReasoningEffort: runtimeProvider === 'codex' ? runtimeCodexReasoningEffort : undefined,
          codexSkills: runtimeProvider === 'codex' ? codexReferences.codexSkills : undefined,
          codexMentions: runtimeProvider === 'codex' ? codexReferences.codexMentions : undefined,
          aegisSkills: runtimeProvider === 'aegis' ? aegisReferences.aegisSkills : undefined,
          aegisMentions: runtimeProvider === 'aegis' ? aegisReferences.aegisMentions : undefined,
          opencodePermissionMode:
            runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
          aegisPermissionMode:
            runtimeProvider === 'aegis' ? runtimeAegisPermissionMode : undefined,
          aegisReasoningEffort:
            runtimeProvider === 'aegis' ? agentRuntime?.aegisReasoningEffort : undefined,
          routedAgentId: runtimeAgentProfile?.id || undefined,
          routedAgentTurns: projectRoutedAgentTurns,
          availableAgentTurns: projectAgentRuntimePayloads,
        },
      });
      resetComposer();
    } else if (targetSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
          sessionId: targetSessionId,
          prompt: outgoingPrompt,
          effectivePrompt: outgoingEffectivePrompt,
          attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
          provider: runtimeProvider,
          model:
            runtimeProvider === 'claude'
              ? runtimeClaudeModel || undefined
              : runtimeProvider === 'codex'
                ? runtimeCodexModel || undefined
                : runtimeProvider === 'opencode'
                  ? runtimeOpencodeModel || undefined
                  : runtimeProvider === 'aegis'
                    ? runtimeAegisModel || undefined
                  : undefined,
          compatibleProviderId:
            runtimeProvider === 'claude' ? runtimeClaudeCompatibleProviderId : undefined,
          claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
          claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
          claudeReasoningEffort: runtimeProvider === 'claude' ? runtimeClaudeReasoningEffort : undefined,
          codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
          codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
          codexReasoningEffort: runtimeProvider === 'codex' ? runtimeCodexReasoningEffort : undefined,
          codexSkills: runtimeProvider === 'codex' ? codexReferences.codexSkills : undefined,
          codexMentions: runtimeProvider === 'codex' ? codexReferences.codexMentions : undefined,
          aegisSkills: runtimeProvider === 'aegis' ? aegisReferences.aegisSkills : undefined,
          aegisMentions: runtimeProvider === 'aegis' ? aegisReferences.aegisMentions : undefined,
          opencodePermissionMode:
            runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
          aegisPermissionMode:
            runtimeProvider === 'aegis' ? runtimeAegisPermissionMode : undefined,
          aegisReasoningEffort:
            runtimeProvider === 'aegis' ? agentRuntime?.aegisReasoningEffort : undefined,
          routedAgentId: runtimeAgentProfile?.id || undefined,
          routedAgentTurns: projectRoutedAgentTurns,
          availableAgentTurns: projectAgentRuntimePayloads,
        },
      });
      resetComposer();
    } else {
      // 没有活动会话，显示新建视图
      setShowNewSession(true);
    }
  };

  const handleStop = () => {
    if (targetSessionId) {
      sendEvent({
        type: 'session.stop',
        payload: { sessionId: targetSessionId },
      });
    }
  };

  const handleAddAttachments = async () => {
    if (isBusy) return;
    const selected = await window.electron.selectAttachments();
    if (!selected || selected.length === 0) return;

    setAttachments((prev) => {
      const existingPaths = new Set(prev.map((a) => a.path));
      const next = [...prev];
      for (const a of selected) {
        if (!existingPaths.has(a.path)) {
          next.push(a);
        }
      }
      return next;
    });
  };

  const handleSelectProjectAgent = useCallback(
    (suggestion: { profile: AgentProfile }) => {
      const mention = projectAgentMentions.mention;
      if (!mention) {
        return;
      }

      const next = insertProjectAgentMention(
        skillAutocomplete.displayPrompt,
        mention,
        suggestion.profile
      );
      skillAutocomplete.setDisplayPrompt(next.prompt);
      setCursorIndex(next.cursorIndex);
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setCursorIndex(next.cursorIndex);
      });
    },
    [projectAgentMentions.mention, skillAutocomplete]
  );

  const handleSelectProjectFile = useCallback(
    async (file: { path: string; relativePath?: string }) => {
      const cwd = activeSession?.cwd;
      const mention = projectFileMentions.mention;
      if (!cwd || !mention) {
        return;
      }

      const next = insertProjectFileMention(
        skillAutocomplete.displayPrompt,
        mention,
        file.relativePath || file.path
      );
      skillAutocomplete.setDisplayPrompt(next.prompt);
      setCursorIndex(next.cursorIndex);
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setCursorIndex(next.cursorIndex);
      });
    },
    [activeSession?.cwd, projectFileMentions.mention, skillAutocomplete]
  );

  const handlePromptChange = async (value: string, nextCursorIndex: number) => {
    await autoConvertComposerTextToAttachment(value, nextCursorIndex);
  };

  const handlePasteImages = useCallback(async (
    images: { mimeType: string; data: Uint8Array; name?: string }[]
  ): Promise<boolean> => {
    if (isBusy || images.length === 0) return false;

    const created: Attachment[] = [];
    let failed = 0;
    for (const image of images) {
      try {
        const attachment = await window.electron.createInlineImageAttachment(
          image.mimeType,
          image.data
        );
        if (attachment) {
          created.push(attachment);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    if (created.length > 0) {
      setAttachments((prev) => {
        const existingPaths = new Set(prev.map((a) => a.path));
        const next = [...prev];
        for (const a of created) {
          if (!existingPaths.has(a.path)) {
            next.push(a);
          }
        }
        return next;
      });
    }

    if (failed > 0) {
      toast.error(`Failed to paste ${failed} image(s). Only PNG/JPEG up to 10MB are supported.`);
    }

    return created.length > 0;
  }, [isBusy]);

  const handleLongPaste = useCallback((
    context: { text: string; start: number; end: number }
  ): boolean => {
    const pastedText = context.text.trim();
    if (pastedText.length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) {
      return false;
    }

    void (async () => {
      const promptWithAttachment = await maybeConvertLongPromptToAttachment({
        cwd: activeSession?.cwd || null,
        prompt: pastedText,
        attachments,
      });

      if (!promptWithAttachment.converted) {
        if (promptWithAttachment.reason === 'attachment_create_failed') {
          toast.error('Failed to convert the long message into an attachment.');
        }
        return;
      }

      const currentPrompt = skillAutocomplete.displayPrompt;
      const nextPrompt = `${currentPrompt.slice(0, context.start)}${currentPrompt.slice(context.end)}`;
      setAttachments(promptWithAttachment.attachments);
      skillAutocomplete.setDisplayPrompt(nextPrompt);
      setCursorIndex(context.start);
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setCursorIndex(context.start);
      });
    })();

    return true;
  }, [activeSession?.cwd, attachments, skillAutocomplete]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isImeComposingEvent(e, isComposingRef)) {
      return;
    }

    if (projectAgentMentionActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        projectAgentMentions.moveSelection(1);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        projectAgentMentions.moveSelection(-1);
        return;
      }

      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        projectAgentMentions.suggestions.length > 0
      ) {
        e.preventDefault();
        const currentSuggestion = projectAgentMentions.getCurrentSuggestion();
        if (currentSuggestion) {
          handleSelectProjectAgent(currentSuggestion);
        }
        return;
      }
    }

    if (projectFileMentions.hasMentionQuery) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        projectFileMentions.moveSelection(1);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        projectFileMentions.moveSelection(-1);
        return;
      }

      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        projectFileMentions.suggestions.length > 0
      ) {
        e.preventDefault();
        const currentSuggestion = projectFileMentions.getCurrentSuggestion();
        if (currentSuggestion) {
          void handleSelectProjectFile(currentSuggestion);
        }
        return;
      }
    }

    if (skillAutocomplete.hasSlashQuery) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        skillAutocomplete.moveSelection(1);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        skillAutocomplete.moveSelection(-1);
        return;
      }

      if ((e.key === 'Enter' || e.key === 'Tab') && skillAutocomplete.suggestions.length > 0) {
        e.preventDefault();
        skillAutocomplete.selectCurrentSuggestion();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isRunning) {
        handleStop();
      } else if (!isBusy) {
        handleSend();
      }
    }
  };

  return (
    <div className="bg-transparent">
      <div className="mx-auto max-w-4xl">
        <div className="group relative rounded-[28px] bg-transparent transition-shadow duration-200">
          {projectAgentMentionActive ? (
            <div className="absolute inset-x-0 bottom-full z-40">
              <ProjectAgentMentionMenu
                suggestions={projectAgentMentions.suggestions}
                selectedIndex={projectAgentMentions.selectedIndex}
                onSelect={handleSelectProjectAgent}
              />
            </div>
          ) : projectFileMentions.hasMentionQuery ? (
            <div className="absolute inset-x-0 bottom-full z-40">
              <ProjectFileMentionMenu
                suggestions={projectFileMentions.suggestions}
                selectedIndex={projectFileMentions.selectedIndex}
                loading={projectFileMentions.loading}
                onSelect={(suggestion) => {
                  void handleSelectProjectFile(suggestion);
                }}
              />
            </div>
          ) : skillAutocomplete.hasSlashQuery && (
            <div className="absolute inset-x-0 bottom-full z-40">
              <ClaudeSkillMenu
                suggestions={skillAutocomplete.suggestions}
                selectedIndex={skillAutocomplete.selectedIndex}
                empty={skillAutocomplete.suggestions.length === 0}
                title={skillAutocomplete.menuTitle}
                emptyMessage={skillAutocomplete.emptyMessage}
                onSelect={skillAutocomplete.selectSuggestion}
                onHighlight={skillAutocomplete.setSelectedIndex}
              />
            </div>
          )}
          {approvalPending && approvalPanel ? (
            approvalPanel
          ) : (
          <div className="rounded-[26px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)] transition-[border-color,box-shadow] duration-200 focus-within:border-[color-mix(in_srgb,var(--border)_92%,transparent)] focus-within:shadow-[0_20px_52px_rgba(15,23,42,0.12)]">
          {attachments.length > 0 && (
            <div className="px-5 pt-4">
              <AttachmentChips
                attachments={attachments}
                onRemove={(id) =>
                  setAttachments((prev) => prev.filter((a) => a.id !== id))
                }
              />
            </div>
          )}

          <ComposerPromptEditor
            ref={editorRef}
            value={skillAutocomplete.displayPrompt}
            cursorIndex={cursorIndex}
            slashContext={skillAutocomplete.slashContext}
            agentMentionLabels={projectAgentMentionLabels}
            onChange={(value, nextCursorIndex) => {
              void handlePromptChange(value, nextCursorIndex);
            }}
            onPasteText={(context) => {
              return handleLongPaste(context);
            }}
            onPasteImages={(images) => {
              void handlePasteImages(images);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              approvalPending
                ? 'Resolve this approval request to continue'
                : isRunning
                ? 'Press Enter to stop...'
                : pendingStart
                ? 'Starting session...'
                : composerBlocker
                  ? `${composerBlocker.title}. ${composerBlocker.description}`
                  : 'Sending to the agent...'
            }
            disabled={pendingStart || approvalPending}
            className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50"
            autoFocus={false}
          />

          <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
              {!directAgentProfile && activeProjectAgentRoutes.length === 0 ? (
                <ProjectAgentPicker
                  profiles={projectAgentProfiles}
                  selectedProfile={selectedProjectAgentProfile}
                  disabled={isBusy}
                  onSelect={(profileId) => {
                    if (activeProjectKey) {
                      setSelectedProjectAgentForProject(activeProjectKey, profileId);
                    }
                  }}
                />
              ) : activeComposerAgentProfile ? (
                <div
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)]"
                  title={activeComposerAgentProfiles
                    .map((profile) => profile.name.trim() || 'Agent')
                    .join(', ')}
                >
                  <AgentAvatar profile={activeComposerAgentProfile} size="sm" decorative />
                  <span className="max-w-[140px] truncate">
                    {activeComposerAgentProfile.name.trim() || 'Agent'}
                  </span>
                  {activeComposerAgentProfiles.length > 1 ? (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      +{activeComposerAgentProfiles.length - 1}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  void handleAddAttachments();
                }}
                disabled={isBusy}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                title="Add files or photos"
                aria-label="Add files or photos"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {codexContextSnapshot ? (
                <CodexContextIndicator snapshot={codexContextSnapshot} />
              ) : null}
              {isRunning && !approvalPending ? (
                <button
                onClick={handleStop}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105"
                title="Stop"
                aria-label="Stop"
              >
                  <Square className="h-2.5 w-2.5" fill="currentColor" />
                </button>
              ) : (
              <button
                onClick={handleSend}
                disabled={
                  (!prompt.trim() && attachments.length === 0) ||
                  isBusy
                }
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100"
                title={composerBlocker ? composerBlocker.description : 'Send'}
                aria-label="Send"
              >
                  <ArrowUpIcon />
                </button>
              )}
            </div>
          </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" />
    </svg>
  );
}
