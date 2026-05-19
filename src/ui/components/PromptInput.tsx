import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { Plus, Square } from './icons';
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
import { ProjectAgentPicker } from './ProjectAgentPicker';
import { ProjectTeamPicker } from './ProjectTeamPicker';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { useProjectAgentMentions } from '../hooks/useProjectAgentMentions';
import {
  DEFAULT_WORKSPACE_CHANNEL_ID,
  type RoutedAgentRuntimePayload,
  type RoutedAgentTurnPayload,
  type SessionTeamMode,
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
import {
  buildAgentEffectivePrompt,
  buildAgentRuntimePayload,
  getAgentRuntime,
  toPublicAgentProfile,
} from '../utils/agent-runtime';

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
    teamProfiles,
    workspaceChannelsByProject,
    projectAgentRostersByProject,
    selectedProjectAgentByProject,
    setSelectedProjectAgentForProject,
    setSessionTeam,
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
  const projectAgentKeyCandidates = useMemo(() => {
    if (activeSession?.scope === 'dm') {
      return [];
    }

    return Array.from(
      new Set(
        [activeSession?.projectCwd, activeSession?.cwd]
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value))
      )
    );
  }, [activeSession?.cwd, activeSession?.projectCwd, activeSession?.scope]);
  const activeProjectKey = projectAgentKeyCandidates[0] || null;
  const activeProjectRosterKey = useMemo(() => {
    for (const projectKey of projectAgentKeyCandidates) {
      if (Object.prototype.hasOwnProperty.call(projectAgentRostersByProject, projectKey)) {
        return projectKey;
      }
    }
    return activeProjectKey;
  }, [activeProjectKey, projectAgentKeyCandidates, projectAgentRostersByProject]);
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
            cwd: activeProjectRosterKey,
          }),
    [activeProjectRosterKey, activeSession?.scope, agentProfiles, projectAgentRostersByProject]
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

    const persistedProfileId =
      selectedProjectAgentByProject[activeProjectRosterKey || activeProjectKey] ||
      selectedProjectAgentByProject[activeProjectKey];
    return (
      projectAgentProfiles.find((profile) => profile.id === persistedProfileId) ||
      projectAgentProfiles[0] ||
      null
    );
  }, [activeProjectKey, activeProjectRosterKey, projectAgentProfiles, selectedProjectAgentByProject]);
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
  const teamOptions = useMemo(
    () => Object.values(teamProfiles).sort((left, right) => left.createdAt - right.createdAt),
    [teamProfiles]
  );
  const activeProjectChannels = activeProjectKey
    ? workspaceChannelsByProject[activeProjectKey] || []
    : [];
  const activeChannel = activeProjectChannels.find(
    (channel) => channel.id === (activeSession?.channelId || DEFAULT_WORKSPACE_CHANNEL_ID)
  );
  const channelDefaultTeam = activeChannel?.defaultTeamId
    ? teamProfiles[activeChannel.defaultTeamId] || null
    : null;
  const sessionTeamMode = activeSession?.teamMode || 'channel_default';
  const explicitAgentMention = activeProjectAgentRoutes.length > 0;
  const sessionSelectedTeam =
    (sessionTeamMode === 'team' || sessionTeamMode === 'manual') && activeSession?.teamId
      ? teamProfiles[activeSession.teamId] || null
      : sessionTeamMode === 'channel_default'
        ? channelDefaultTeam
        : null;
  const effectiveTeamProfile =
    !directAgentProfile && !explicitAgentMention && sessionTeamMode !== 'solo'
      ? sessionSelectedTeam
      : null;
  const teamLeaderProfile =
    effectiveTeamProfile?.leaderAgentId
      ? agentProfiles[effectiveTeamProfile.leaderAgentId] || null
      : null;
  const runtimeAgentProfile = directAgentProfile || teamLeaderProfile || activeProjectAgentRoute?.profile || null;
  const agentRuntime = getAgentRuntime(runtimeAgentProfile);
  const runtimeProvider = agentRuntime?.provider || 'claude';
  const activeComposerAgentProfiles = directAgentProfile
    ? [directAgentProfile]
    : runtimeAgentProfile
      ? [runtimeAgentProfile]
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

  const handleSelectTeam = useCallback(
    (mode: SessionTeamMode, teamId?: string | null) => {
      if (!activeSession) return;
      setSessionTeam(activeSession.id, mode, teamId || null);
      if (!activeSession.isDraft) {
        sendEvent({
          type: 'session.setTeam',
          payload: { sessionId: activeSession.id, teamMode: mode, teamId: teamId || null },
        });
      }
    },
    [activeSession, setSessionTeam]
  );

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
          : undefined,
      { includeIdentity: runtimeProvider !== 'aegis' }
    );
    const codexReferences = buildCodexReferencePayload(skillAutocomplete.selectedSkill);
    const aegisReferences = buildAegisReferencePayload(skillAutocomplete.selectedSkill);
    const activeAgentRuntimePayload = buildAgentRuntimePayload(runtimeAgentProfile, codexReferences, aegisReferences);
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
        routedAgentProfile: runtimeProvider === 'aegis' ? activeAgentRuntimePayload : undefined,
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

    if (projectAgentProfiles.length === 0 && !effectiveTeamProfile) {
      return {
        title: 'No agents assigned to this project',
        description: 'Create an agent profile or add one to this project.',
      };
    }

    if (effectiveProjectAgentRoutes.length === 0 && !effectiveTeamProfile) {
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
    effectiveTeamProfile,
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
    const outgoingAttachments = promptWithAttachment.attachments;
    const codexReferences = buildCodexReferencePayload(skillAutocomplete.selectedSkill);
    const aegisReferences = buildAegisReferencePayload(skillAutocomplete.selectedSkill);
    const activeAgentRuntimePayload = buildAgentRuntimePayload(runtimeAgentProfile, codexReferences, aegisReferences);
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
          : undefined,
      { includeIdentity: runtimeProvider !== 'aegis' }
    );
    const projectAgentRuntimePayloads =
      !directAgentProfile
        ? projectAgentProfiles
            .map((profile) => buildAgentRuntimePayload(profile, codexReferences, aegisReferences))
            .filter((turn): turn is RoutedAgentRuntimePayload => Boolean(turn))
        : undefined;
    const teamAgentRuntimePayloads =
      effectiveTeamProfile && runtimeProvider === 'aegis'
        ? effectiveTeamProfile.members
            .filter((member) => member.enabled && member.agentId !== runtimeAgentProfile?.id)
            .map((member) => agentProfiles[member.agentId])
            .filter((profile): profile is AgentProfile => Boolean(profile?.enabled))
            .map((profile) => buildAgentRuntimePayload(profile, codexReferences, aegisReferences))
            .filter((turn): turn is RoutedAgentRuntimePayload => Boolean(turn))
        : undefined;
    const projectPublicAgents =
      !directAgentProfile ? projectAgentProfiles.map(toPublicAgentProfile) : undefined;
    const shouldUseRoutedAgentTurns = runtimeProvider !== 'aegis' || activeProjectAgentRoutes.length > 0;
    const projectRoutedAgentTurns: RoutedAgentTurnPayload[] | undefined =
      shouldUseRoutedAgentTurns && !directAgentProfile && effectiveProjectAgentRoutes.length > 0
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
                },
                { includeIdentity: routeRuntime.provider !== 'aegis' }
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
          projectCwd: isDirectMessageDraft ? undefined : activeSession.projectCwd ?? activeSession.cwd ?? null,
          envMode: isDirectMessageDraft ? undefined : activeSession.envMode ?? 'local',
          worktreePath: isDirectMessageDraft ? undefined : activeSession.worktreePath ?? null,
          associatedWorktreePath: isDirectMessageDraft ? undefined : activeSession.associatedWorktreePath ?? null,
          associatedWorktreeBranch: isDirectMessageDraft ? undefined : activeSession.associatedWorktreeBranch ?? null,
          associatedWorktreeRef: isDirectMessageDraft ? undefined : activeSession.associatedWorktreeRef ?? null,
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
          routedAgentProfile: runtimeProvider === 'aegis' ? activeAgentRuntimePayload : undefined,
          routedAgentTurns: projectRoutedAgentTurns,
          availableAgentTurns: projectAgentRuntimePayloads,
          teamMode: activeSession.teamMode || 'channel_default',
          teamId: activeSession.teamId || null,
          teamProfile: runtimeProvider === 'aegis' ? effectiveTeamProfile || null : undefined,
          teamAgentTurns: runtimeProvider === 'aegis' ? teamAgentRuntimePayloads : undefined,
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
          routedAgentProfile: runtimeProvider === 'aegis' ? activeAgentRuntimePayload : undefined,
          routedAgentTurns: projectRoutedAgentTurns,
          availableAgentTurns: projectAgentRuntimePayloads,
          teamMode: activeSession.teamMode || 'channel_default',
          teamId: activeSession.teamId || null,
          teamProfile: runtimeProvider === 'aegis' ? effectiveTeamProfile || null : undefined,
          teamAgentTurns: runtimeProvider === 'aegis' ? teamAgentRuntimePayloads : undefined,
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
                    const projectKey = activeProjectRosterKey || activeProjectKey;
                    if (projectKey) {
                      setSelectedProjectAgentForProject(projectKey, profileId);
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
              {!directAgentProfile && activeProjectAgentRoutes.length === 0 ? (
                <ProjectTeamPicker
                  teams={teamOptions}
                  selectedMode={sessionTeamMode}
                  selectedTeam={sessionSelectedTeam}
                  channelDefaultTeam={channelDefaultTeam}
                  disabled={isBusy}
                  onSelect={handleSelectTeam}
                />
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
