import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Paperclip, Plus, Square, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type {
  Attachment,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeReasoningEffort,
  ClaudeCompatibleProviderId,
  CodexExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  AgentProfile,
  OpenCodePermissionMode,
} from '../types';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeAccessModePicker } from './ClaudeAccessModePicker';
import { ReasoningTraitsPicker } from './ReasoningTraitsPicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { PlanModeBadge, PlanModeMenuItem } from './PlanModeControls';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ProjectAgentMentionMenu } from './ProjectAgentMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { SavePromptButton } from './prompts/SavePromptButton';
import { AgentAvatar } from './AgentAvatar';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { useProjectAgentMentions } from '../hooks/useProjectAgentMentions';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getSessionModel } from '../utils/session-model';
import {
  buildClaudeModelOptions,
  isOfficialClaudeModel,
  loadPreferredClaudeCompatibleProviderId,
  loadPreferredClaudeContext1m,
  loadPreferredClaudeModel,
  savePreferredClaudeCompatibleProviderId,
  savePreferredClaudeContext1m,
  savePreferredClaudeModel,
  supportsClaude1mContext,
} from '../utils/claude-model';
import {
  getClaudeReasoningOptions,
  getDefaultClaudeReasoningEffort,
  savePreferredClaudeReasoningEffort,
} from '../utils/claude-reasoning';
import {
  buildCodexModelOptions,
  loadPreferredCodexModel,
  resolveCodexModel,
  savePreferredCodexModel,
} from '../utils/codex-model';
import { loadPreferredCodexExecutionMode, savePreferredCodexExecutionMode } from '../utils/codex-execution';
import { loadPreferredCodexPermissionMode, savePreferredCodexPermissionMode } from '../utils/codex-permission';
import {
  getCodexReasoningOptions,
  getDefaultCodexReasoningEffort,
  savePreferredCodexReasoningEffort,
} from '../utils/codex-reasoning';
import {
  loadPreferredCodexFastMode,
  savePreferredCodexFastMode,
  supportsCodexFastMode,
} from '../utils/codex-fast';
import { buildOpencodeModelOptions, loadPreferredOpencodeModel, savePreferredOpencodeModel } from '../utils/opencode-model';
import {
  loadPreferredOpencodePermissionMode,
  savePreferredOpencodePermissionMode,
} from '../utils/opencode-permission';
import { insertProjectFileMention } from '../utils/project-file-mentions';
import { buildPromptWithProjectFileMentions } from '../utils/project-file-mention-context';
import {
  LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD,
  maybeConvertLongPromptToAttachment,
} from '../utils/long-prompt-attachment';
import { buildCodexReferencePayload } from '../utils/codex-composer';
import {
  getAgentMentionHandle,
  getAgentMentionHandles,
  getAgentMentionAliases,
  getProjectAgentProfiles,
  insertProjectAgentMention,
  resolveProjectAgentMentionRoute,
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

  const isReadOnly = profile.permissionPolicy === 'readOnly';
  const isFullAccess = profile.permissionPolicy === 'fullAccess';

  return {
    provider: profile.provider,
    model: profile.model?.trim() || null,
    claudeAccessMode: isFullAccess ? 'fullAccess' as const : 'default' as const,
    claudeExecutionMode: isReadOnly ? 'plan' as const : 'execute' as const,
    codexExecutionMode: isReadOnly ? 'plan' as const : 'execute' as const,
    codexPermissionMode: isFullAccess ? 'fullAccess' as const : 'defaultPermissions' as const,
    opencodePermissionMode: isFullAccess ? 'fullAccess' as const : 'defaultPermissions' as const,
  };
}

function getAgentProviderLabel(provider: AgentProfile['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude';
}

function isVisibleClaudePickerModel(
  model: string | null | undefined,
  compatibleOptions: Array<{ model: string }>
): model is string {
  const normalized = model?.trim();
  if (!normalized) {
    return false;
  }

  return isOfficialClaudeModel(normalized) || compatibleOptions.some((option) => option.model === normalized);
}

export function PromptInput({ sessionId }: { sessionId?: string | null } = {}) {
  const {
    activeSessionId,
    sessions,
    agentProfiles,
    projectAgentRostersByProject,
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [provider, setProvider] = useState(loadPreferredProvider());
  const [selectedClaudeModel, setSelectedClaudeModel] = useState<string | null>(
    loadPreferredClaudeModel()
  );
  const [selectedClaudeCompatibleProviderId, setSelectedClaudeCompatibleProviderId] =
    useState<ClaudeCompatibleProviderId | null>(loadPreferredClaudeCompatibleProviderId());
  const [selectedClaudeContext1m, setSelectedClaudeContext1m] = useState(loadPreferredClaudeContext1m());
  const [selectedCodexModel, setSelectedCodexModel] = useState<string | null>(
    loadPreferredCodexModel()
  );
  const [selectedOpencodeModel, setSelectedOpencodeModel] = useState<string | null>(
    loadPreferredOpencodeModel()
  );
  const [selectedClaudeAccessMode, setSelectedClaudeAccessMode] = useState<ClaudeAccessMode>('default');
  const [selectedClaudeExecutionMode, setSelectedClaudeExecutionMode] = useState<ClaudeExecutionMode>('execute');
  const [selectedClaudeReasoningEffort, setSelectedClaudeReasoningEffort] =
    useState<ClaudeReasoningEffort>('high');
  const [selectedCodexExecutionMode, setSelectedCodexExecutionMode] = useState<CodexExecutionMode>(
    loadPreferredCodexExecutionMode()
  );
  const [selectedCodexPermissionMode, setSelectedCodexPermissionMode] = useState<CodexPermissionMode>(
    loadPreferredCodexPermissionMode()
  );
  const [selectedCodexReasoningEffort, setSelectedCodexReasoningEffort] =
    useState<CodexReasoningEffort>('medium');
  const [selectedCodexFastMode, setSelectedCodexFastMode] = useState(false);
  const [selectedOpencodePermissionMode, setSelectedOpencodePermissionMode] =
    useState<OpenCodePermissionMode>(loadPreferredOpencodePermissionMode());
  const [selectedTaskAgentId, setSelectedTaskAgentId] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const targetSessionId = sessionId ?? activeSessionId;

  const activeSession = targetSessionId ? sessions[targetSessionId] : null;
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
  const projectAgentRoute = useMemo(
    () =>
      activeSession?.scope === 'dm'
        ? null
        : resolveProjectAgentMentionRoute(prompt, projectAgentProfiles),
    [activeSession?.scope, projectAgentProfiles, prompt]
  );
  const selectedTaskAgentProfile = useMemo(
    () =>
      selectedTaskAgentId
        ? projectAgentProfiles.find((profile) => profile.id === selectedTaskAgentId) || null
        : null,
    [projectAgentProfiles, selectedTaskAgentId]
  );
  const activeProjectAgentRoute = projectAgentRoute
    ? {
        profile: projectAgentRoute.profile,
        handle: projectAgentRoute.handle,
        source: 'mention' as const,
      }
    : selectedTaskAgentProfile
      ? {
          profile: selectedTaskAgentProfile,
          handle: getAgentMentionHandle(selectedTaskAgentProfile),
          source: 'assignment' as const,
        }
      : null;
  const runtimeAgentProfile = directAgentProfile || activeProjectAgentRoute?.profile || null;
  const directAgentRuntime = getAgentRuntime(directAgentProfile);
  const projectAgentRuntime = getAgentRuntime(activeProjectAgentRoute?.profile || null);
  const agentRuntime = directAgentRuntime || projectAgentRuntime;
  const runtimeProvider = agentRuntime?.provider || provider;
  const runtimeLockedByAgent = Boolean(agentRuntime);
  const isRunning = activeSession?.status === 'running';
  const isBusy = isRunning || pendingStart;
  const claudeModelConfig = useClaudeModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const availableClaudeModels = useMemo(
    () =>
      buildClaudeModelOptions(
        claudeModelConfig,
        compatibleOptions.map((option) => option.model)
      ),
    [claudeModelConfig, compatibleOptions]
  );
  const resolvedSelectedClaudeModel = useMemo(
    () => selectedClaudeModel || claudeModelConfig.defaultModel || availableClaudeModels[0] || null,
    [availableClaudeModels, claudeModelConfig.defaultModel, selectedClaudeModel]
  );
  const claudeReasoningOptions = useMemo(
    () =>
      selectedClaudeCompatibleProviderId
        ? []
        : getClaudeReasoningOptions(resolvedSelectedClaudeModel),
    [resolvedSelectedClaudeModel, selectedClaudeCompatibleProviderId]
  );
  const codexModelConfig = useCodexModelConfig();
  const codexModelOptions = useMemo(
    () => buildCodexModelOptions(codexModelConfig),
    [codexModelConfig]
  );
  const resolvedSelectedCodexModel = useMemo(
    () => resolveCodexModel(selectedCodexModel, codexModelConfig),
    [codexModelConfig, selectedCodexModel]
  );
  const codexReasoningOptions = useMemo(
    () => getCodexReasoningOptions(codexModelConfig, resolvedSelectedCodexModel),
    [codexModelConfig, resolvedSelectedCodexModel]
  );
  const codexDefaultReasoningEffort = useMemo(() => {
    const matched = codexModelConfig.availableModels.find((entry) => entry.name === resolvedSelectedCodexModel);
    return (
      matched?.defaultReasoningEffort ||
      codexModelConfig.defaultReasoningEffort ||
      codexReasoningOptions[0]?.effort ||
      'medium'
    );
  }, [codexModelConfig, codexReasoningOptions, resolvedSelectedCodexModel]);
  const codexFastModeSupported = useMemo(
    () => supportsCodexFastMode(codexModelConfig, resolvedSelectedCodexModel),
    [codexModelConfig, resolvedSelectedCodexModel]
  );
  const opencodeModelConfig = useOpencodeModelConfig();
  const opencodeModelOptions = useMemo(
    () => buildOpencodeModelOptions(opencodeModelConfig),
    [opencodeModelConfig]
  );
  const activeClaudeModel = useMemo(
    () => (runtimeProvider === 'claude' ? activeSession?.model || getSessionModel(activeSession?.messages) : null),
    [runtimeProvider, activeSession?.messages, activeSession?.model]
  );
  const visibleActiveClaudeModel = useMemo(() => {
    if (!isVisibleClaudePickerModel(activeSession?.model, compatibleOptions)) {
      return isVisibleClaudePickerModel(activeClaudeModel, compatibleOptions) ? activeClaudeModel.trim() : null;
    }

    return activeSession.model.trim();
  }, [activeClaudeModel, activeSession?.model, compatibleOptions]);
  const runtimeClaudeModel =
    runtimeProvider === 'claude'
      ? agentRuntime?.model || selectedClaudeModel
      : selectedClaudeModel;
  const runtimeCodexModel =
    runtimeProvider === 'codex'
      ? agentRuntime?.model || resolvedSelectedCodexModel
      : resolvedSelectedCodexModel;
  const runtimeOpencodeModel =
    runtimeProvider === 'opencode'
      ? agentRuntime?.model || selectedOpencodeModel || opencodeModelOptions[0] || null
      : selectedOpencodeModel;
  const runtimeClaudeAccessMode = agentRuntime?.claudeAccessMode || selectedClaudeAccessMode;
  const runtimeClaudeExecutionMode =
    agentRuntime?.claudeExecutionMode || selectedClaudeExecutionMode;
  const runtimeCodexExecutionMode =
    agentRuntime?.codexExecutionMode || selectedCodexExecutionMode;
  const runtimeCodexPermissionMode =
    agentRuntime?.codexPermissionMode || selectedCodexPermissionMode;
  const runtimeOpencodePermissionMode =
    agentRuntime?.opencodePermissionMode || selectedOpencodePermissionMode;
  const handleAutoSubmitClaudeCommand = (nextPrompt: string) => {
    if (!targetSessionId || !activeSession || activeSession.isDraft) {
      setPrompt(nextPrompt);
      return;
    }

    setMenuOpen(false);
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
              assignmentSource: activeProjectAgentRoute.source,
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
            ? runtimeClaudeModel || claudeModelConfig.defaultModel || undefined
            : runtimeProvider === 'codex'
              ? runtimeCodexModel || undefined
              : runtimeProvider === 'opencode'
                ? runtimeOpencodeModel || undefined
                : undefined,
        compatibleProviderId:
          runtimeProvider === 'claude' && !runtimeLockedByAgent
            ? selectedClaudeCompatibleProviderId || undefined
            : undefined,
        betas:
          runtimeProvider === 'claude' &&
          !runtimeLockedByAgent &&
          supportsClaude1mContext(runtimeClaudeModel || claudeModelConfig.defaultModel || null) &&
          selectedClaudeContext1m
            ? ['context-1m-2025-08-07']
            : undefined,
        claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
        claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
        claudeReasoningEffort: runtimeProvider === 'claude' ? selectedClaudeReasoningEffort : undefined,
        codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
        codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
        codexReasoningEffort:
          runtimeProvider === 'codex' ? selectedCodexReasoningEffort : undefined,
        codexFastMode:
          runtimeProvider === 'codex' && !runtimeLockedByAgent ? selectedCodexFastMode : undefined,
        opencodePermissionMode:
          runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
        routedAgentId: runtimeAgentProfile?.id || undefined,
      },
    });
    setPrompt('');
    setAttachments([]);
    setSelectedTaskAgentId(null);
  };
  const skillAutocomplete = useClaudeSkillAutocomplete({
    enabled: true,
    enableSkills: true,
    provider: runtimeProvider,
    prompt,
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
  const promptLibraryContent = useMemo(() => prompt.trim(), [prompt]);

  useEffect(() => {
    setSelectedTaskAgentId(null);
  }, [targetSessionId]);

  useEffect(() => {
    if (!selectedTaskAgentId) {
      return;
    }
    if (!projectAgentProfiles.some((profile) => profile.id === selectedTaskAgentId)) {
      setSelectedTaskAgentId(null);
    }
  }, [projectAgentProfiles, selectedTaskAgentId]);

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

  useEffect(() => {
    if (activeSession?.provider) {
      setProvider(activeSession.provider);
      savePreferredProvider(activeSession.provider);
    }
  }, [targetSessionId, activeSession?.provider]);

  useEffect(() => {
    if (directAgentRuntime) {
      setProvider(directAgentRuntime.provider);
    }
  }, [directAgentRuntime?.provider]);

  useEffect(() => {
    if (activeSession?.scope !== 'dm' || !activeSession.model) {
      return;
    }

    if (activeSession.provider === 'claude') {
      setSelectedClaudeModel(activeSession.model);
    } else if (activeSession.provider === 'codex') {
      setSelectedCodexModel(activeSession.model);
    } else if (activeSession.provider === 'opencode') {
      setSelectedOpencodeModel(activeSession.model);
    }
  }, [activeSession?.model, activeSession?.provider, activeSession?.scope, targetSessionId]);

  useEffect(() => {
    if (activeSession?.provider === 'claude') {
      setSelectedClaudeAccessMode(activeSession.claudeAccessMode || 'default');
      setSelectedClaudeExecutionMode(activeSession.claudeExecutionMode || 'execute');
      setSelectedClaudeReasoningEffort(
        activeSession.claudeReasoningEffort ||
        getDefaultClaudeReasoningEffort(activeSession.model || resolvedSelectedClaudeModel)
      );
      return;
    }

    if (!targetSessionId) {
      setSelectedClaudeAccessMode('default');
      setSelectedClaudeExecutionMode('execute');
      setSelectedClaudeReasoningEffort(getDefaultClaudeReasoningEffort(resolvedSelectedClaudeModel));
    }
  }, [
    activeSession?.claudeAccessMode,
    activeSession?.claudeExecutionMode,
    activeSession?.claudeReasoningEffort,
    activeSession?.model,
    activeSession?.provider,
    resolvedSelectedClaudeModel,
    targetSessionId,
  ]);

  useEffect(() => {
    if (activeSession?.provider === 'codex') {
      setSelectedCodexExecutionMode(activeSession.codexExecutionMode || 'execute');
      setSelectedCodexPermissionMode(activeSession.codexPermissionMode || 'defaultPermissions');
      setSelectedCodexReasoningEffort(
        activeSession.codexReasoningEffort ||
          getDefaultCodexReasoningEffort(
            codexModelConfig,
            resolveCodexModel(activeSession.model || selectedCodexModel, codexModelConfig)
          )
      );
      setSelectedCodexFastMode(activeSession.codexFastMode === true);
      return;
    }

    if (!targetSessionId) {
      setSelectedCodexExecutionMode(loadPreferredCodexExecutionMode());
      setSelectedCodexPermissionMode(loadPreferredCodexPermissionMode());
    }
  }, [
    activeSession?.codexExecutionMode,
    activeSession?.codexPermissionMode,
    activeSession?.codexReasoningEffort,
    activeSession?.codexFastMode,
    activeSession?.model,
    activeSession?.provider,
    targetSessionId,
    codexModelConfig,
    selectedCodexModel,
  ]);

  useEffect(() => {
    if (activeSession?.provider === 'opencode') {
      setSelectedOpencodePermissionMode(activeSession.opencodePermissionMode || 'defaultPermissions');
      return;
    }

    if (!targetSessionId) {
      setSelectedOpencodePermissionMode(loadPreferredOpencodePermissionMode());
    }
  }, [activeSession?.opencodePermissionMode, activeSession?.provider, targetSessionId]);

  useEffect(() => {
    if (activeSession?.provider !== 'claude') {
      return;
    }

    // Intentionally skip syncing selectedClaudeModel from session here: the
    // picker reflects the user's explicit choice and should not be overwritten
    // by the CLI-resolved version that the backend writes into session.model
    // after a request completes.
    setSelectedClaudeCompatibleProviderId(
      activeSession.compatibleProviderId || loadPreferredClaudeCompatibleProviderId()
    );
    setSelectedClaudeContext1m(
      !!activeSession?.betas?.includes('context-1m-2025-08-07') || loadPreferredClaudeContext1m()
    );
  }, [
    targetSessionId,
    activeSession?.provider,
    activeSession?.compatibleProviderId,
    activeSession?.betas,
  ]);

  useEffect(() => {
    if (provider !== 'claude') {
      return;
    }

    const fallbackModel =
      claudeModelConfig.defaultModel ||
      availableClaudeModels[0] ||
      null;

    if (!fallbackModel) {
      return;
    }

    if (!selectedClaudeModel || !availableClaudeModels.includes(selectedClaudeModel)) {
      setSelectedClaudeModel(fallbackModel);
      savePreferredClaudeModel(fallbackModel);
    }
  }, [availableClaudeModels, claudeModelConfig.defaultModel, provider, selectedClaudeModel]);

  useEffect(() => {
    if (provider !== 'claude') {
      return;
    }

    if (claudeReasoningOptions.some((option) => option.effort === selectedClaudeReasoningEffort)) {
      return;
    }

    const nextEffort = getDefaultClaudeReasoningEffort(resolvedSelectedClaudeModel);
    setSelectedClaudeReasoningEffort(
      claudeReasoningOptions.some((option) => option.effort === nextEffort)
        ? nextEffort
        : 'high'
    );
  }, [
    claudeReasoningOptions,
    provider,
    resolvedSelectedClaudeModel,
    selectedClaudeReasoningEffort,
  ]);

  useEffect(() => {
    if (!selectedClaudeModel) {
      if (selectedClaudeCompatibleProviderId) {
        setSelectedClaudeCompatibleProviderId(null);
        savePreferredClaudeCompatibleProviderId(null);
      }
      return;
    }

    const matchingOptions = compatibleOptions.filter((option) => option.model === selectedClaudeModel);
    if (matchingOptions.length === 0) {
      if (selectedClaudeCompatibleProviderId) {
        setSelectedClaudeCompatibleProviderId(null);
        savePreferredClaudeCompatibleProviderId(null);
      }
      return;
    }

    if (
      selectedClaudeCompatibleProviderId &&
      matchingOptions.some((option) => option.id === selectedClaudeCompatibleProviderId)
    ) {
      return;
    }

    const nextCompatibleProviderId = matchingOptions.length === 1 ? matchingOptions[0].id : null;
    if (nextCompatibleProviderId !== selectedClaudeCompatibleProviderId) {
      setSelectedClaudeCompatibleProviderId(nextCompatibleProviderId);
      savePreferredClaudeCompatibleProviderId(nextCompatibleProviderId);
    }
  }, [compatibleOptions, selectedClaudeCompatibleProviderId, selectedClaudeModel]);

  useEffect(() => {
    if (activeSession?.provider !== 'codex') {
      if (!codexModelOptions.length) {
        if (selectedCodexModel) {
          setSelectedCodexModel(null);
          savePreferredCodexModel(null);
        }
        return;
      }

      if (selectedCodexModel && codexModelOptions.includes(selectedCodexModel)) {
        return;
      }

      setSelectedCodexModel(codexModelOptions[0] || null);
      savePreferredCodexModel(codexModelOptions[0] || null);
      return;
    }

    const nextModel = resolveCodexModel(
      activeSession.model ||
        loadPreferredCodexModel() ||
        codexModelOptions[0],
      codexModelConfig
    );
    if ((nextModel || null) !== selectedCodexModel) {
      setSelectedCodexModel(nextModel || null);
    }
  }, [
    targetSessionId,
    activeSession?.provider,
    activeSession?.model,
    codexModelConfig,
    codexModelOptions,
  ]);

  useEffect(() => {
    if (!resolvedSelectedCodexModel) {
      return;
    }

    if (
      activeSession?.provider === 'codex' &&
      activeSession.model &&
      resolvedSelectedCodexModel === activeSession.model
    ) {
      return;
    }

    const nextEffort = getDefaultCodexReasoningEffort(codexModelConfig, resolvedSelectedCodexModel);
    if (nextEffort !== selectedCodexReasoningEffort) {
      setSelectedCodexReasoningEffort(nextEffort);
    }
    const nextFastMode = loadPreferredCodexFastMode(codexModelConfig, resolvedSelectedCodexModel);
    if (nextFastMode !== selectedCodexFastMode) {
      setSelectedCodexFastMode(nextFastMode);
    }
  }, [
    activeSession?.provider,
    codexModelConfig,
    resolvedSelectedCodexModel,
    selectedCodexReasoningEffort,
    selectedCodexFastMode,
  ]);

  useEffect(() => {
    if (activeSession?.provider !== 'opencode') {
      if (!opencodeModelOptions.length) {
        if (selectedOpencodeModel) {
          setSelectedOpencodeModel(null);
          savePreferredOpencodeModel(null);
        }
        return;
      }

      if (selectedOpencodeModel && opencodeModelOptions.includes(selectedOpencodeModel)) {
        return;
      }

      setSelectedOpencodeModel(opencodeModelOptions[0] || null);
      savePreferredOpencodeModel(opencodeModelOptions[0] || null);
      return;
    }

    const nextModel =
      activeSession.model ||
      loadPreferredOpencodeModel() ||
      opencodeModelOptions[0];
    if ((nextModel || null) !== selectedOpencodeModel) {
      setSelectedOpencodeModel(nextModel || null);
    }
  }, [
    targetSessionId,
    activeSession?.provider,
    activeSession?.model,
    opencodeModelOptions,
  ]);

  const buildDispatchPrompt = async (): Promise<string | null> => {
    const trimmedPrompt = prompt.trim();

    if (skillAutocomplete.selectedSkill) {
      const expandedPrompt =
        runtimeProvider === 'codex'
          ? skillAutocomplete.selectedSkillRemainder.trim()
          : runtimeProvider === 'claude'
            ? trimmedPrompt
            : await (async () => {
                const result = await window.electron.expandClaudeSkillPrompt(
                  skillAutocomplete.selectedSkill.path,
                  skillAutocomplete.selectedSkill.name,
                  skillAutocomplete.selectedSkillRemainder
                );

                if (!result.ok || !result.prompt) {
                  toast.error(result.message || `Failed to expand /${skillAutocomplete.selectedSkill.name}.`);
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
    setMenuOpen(false);

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
              assignmentSource: activeProjectAgentRoute.source,
            }
          : undefined
    );
    const outgoingAttachments = promptWithAttachment.attachments;
    const codexReferences =
      runtimeProvider === 'codex'
        ? buildCodexReferencePayload(skillAutocomplete.selectedSkill)
        : {};
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
              ? runtimeClaudeModel || claudeModelConfig.defaultModel || undefined
              : runtimeProvider === 'codex'
                ? runtimeCodexModel || undefined
                : runtimeProvider === 'opencode'
                  ? runtimeOpencodeModel || undefined
                  : undefined,
          compatibleProviderId:
            runtimeProvider === 'claude' && !runtimeLockedByAgent
              ? selectedClaudeCompatibleProviderId || undefined
              : undefined,
          betas:
            runtimeProvider === 'claude' &&
            !runtimeLockedByAgent &&
            supportsClaude1mContext(runtimeClaudeModel || claudeModelConfig.defaultModel || null) &&
            selectedClaudeContext1m
              ? ['context-1m-2025-08-07']
              : undefined,
          claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
          claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
          claudeReasoningEffort: runtimeProvider === 'claude' ? selectedClaudeReasoningEffort : undefined,
          codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
          codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
          codexReasoningEffort:
            runtimeProvider === 'codex' ? selectedCodexReasoningEffort : undefined,
          codexFastMode:
            runtimeProvider === 'codex' && !runtimeLockedByAgent ? selectedCodexFastMode : undefined,
          codexSkills: runtimeProvider === 'codex' ? codexReferences.codexSkills : undefined,
          codexMentions: runtimeProvider === 'codex' ? codexReferences.codexMentions : undefined,
          opencodePermissionMode:
            runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
          routedAgentId: runtimeAgentProfile?.id || undefined,
        },
      });
      setPrompt('');
      setAttachments([]);
      setSelectedTaskAgentId(null);
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
              ? runtimeClaudeModel || claudeModelConfig.defaultModel || undefined
              : runtimeProvider === 'codex'
                ? runtimeCodexModel || undefined
                : runtimeProvider === 'opencode'
                  ? runtimeOpencodeModel || undefined
                  : undefined,
          compatibleProviderId:
            runtimeProvider === 'claude' && !runtimeLockedByAgent
              ? selectedClaudeCompatibleProviderId || undefined
              : undefined,
          betas:
            runtimeProvider === 'claude' &&
            !runtimeLockedByAgent &&
            supportsClaude1mContext(runtimeClaudeModel || claudeModelConfig.defaultModel || null) &&
            selectedClaudeContext1m
              ? ['context-1m-2025-08-07']
              : undefined,
          claudeAccessMode: runtimeProvider === 'claude' ? runtimeClaudeAccessMode : undefined,
          claudeExecutionMode: runtimeProvider === 'claude' ? runtimeClaudeExecutionMode : undefined,
          claudeReasoningEffort: runtimeProvider === 'claude' ? selectedClaudeReasoningEffort : undefined,
          codexExecutionMode: runtimeProvider === 'codex' ? runtimeCodexExecutionMode : undefined,
          codexPermissionMode: runtimeProvider === 'codex' ? runtimeCodexPermissionMode : undefined,
          codexReasoningEffort:
            runtimeProvider === 'codex' ? selectedCodexReasoningEffort : undefined,
          codexFastMode:
            runtimeProvider === 'codex' && !runtimeLockedByAgent ? selectedCodexFastMode : undefined,
          codexSkills: runtimeProvider === 'codex' ? codexReferences.codexSkills : undefined,
          codexMentions: runtimeProvider === 'codex' ? codexReferences.codexMentions : undefined,
          opencodePermissionMode:
            runtimeProvider === 'opencode' ? runtimeOpencodePermissionMode : undefined,
          routedAgentId: runtimeAgentProfile?.id || undefined,
        },
      });
      setPrompt('');
      setAttachments([]);
      setSelectedTaskAgentId(null);
    } else {
      // 没有活动会话，显示新建视图
      setShowNewSession(true);
    }
  };

  const handleStop = () => {
    setMenuOpen(false);
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
                title="Commands & Skills"
                emptyMessage="No matching commands or skills."
                onSelect={skillAutocomplete.selectSuggestion}
              />
            </div>
          )}
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
              isRunning
                ? 'Press Enter to stop...'
                : pendingStart
                ? 'Starting session...'
                : targetSessionId
                ? 'Continue the conversation...'
                : 'Start a new session...'
            }
            disabled={isBusy}
            className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50"
            autoFocus={false}
          />

          <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
              {activeProjectAgentRoute ? (
                <div
                  className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2 text-[12px] text-[var(--text-secondary)]"
                  title={`${activeProjectAgentRoute.source === 'assignment' ? 'Assigned to' : 'Routed to'} ${activeProjectAgentRoute.profile.name.trim() || 'Agent'}`}
                >
                  <AgentAvatar profile={activeProjectAgentRoute.profile} size="sm" decorative />
                  <span className="max-w-[120px] truncate">
                    @{activeProjectAgentRoute.handle}
                  </span>
                  {activeProjectAgentRoute.source === 'assignment' ? (
                    <button
                      type="button"
                      onClick={() => setSelectedTaskAgentId(null)}
                      className="-mr-1 flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                      aria-label="Clear assigned agent"
                      title="Clear assigned agent"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              ) : null}
              <AgentModelPicker
              provider={runtimeProvider}
              onProviderChange={(next) => {
                if (runtimeLockedByAgent) {
                  return;
                }
                setProvider(next);
                savePreferredProvider(next);
              }}
              disabled={isBusy || runtimeLockedByAgent}
              claudeModel={{
                value: runtimeProvider === 'claude' ? runtimeClaudeModel : selectedClaudeModel,
                compatibleProviderId: selectedClaudeCompatibleProviderId,
                config: claudeModelConfig,
                runtimeModel: visibleActiveClaudeModel,
                runtimeCompatibleProviderId:
                  activeSession?.provider === 'claude' ? activeSession.compatibleProviderId || null : null,
                context1m: selectedClaudeContext1m,
                compatibleOptions,
                onToggleContext1m: (enabled) => {
                  if (runtimeLockedByAgent) {
                    return;
                  }
                  setSelectedClaudeContext1m(enabled);
                  savePreferredClaudeContext1m(enabled);
                },
                onChange: (model, compatibleProviderId) => {
                  if (runtimeLockedByAgent) {
                    return;
                  }
                  setSelectedClaudeModel(model);
                  setSelectedClaudeCompatibleProviderId(compatibleProviderId || null);
                  if (!supportsClaude1mContext(model)) {
                    setSelectedClaudeContext1m(false);
                    savePreferredClaudeContext1m(false);
                  }
                  savePreferredClaudeModel(model);
                  savePreferredClaudeCompatibleProviderId(compatibleProviderId || null);
                },
              }}
              codexModel={{
                value: runtimeProvider === 'codex' ? runtimeCodexModel : selectedCodexModel,
                options: codexModelOptions,
                runtimeModel:
                  activeSession?.provider === 'codex'
                    ? resolveCodexModel(activeSession.model || selectedCodexModel, codexModelConfig)
                    : null,
                onChange: (model) => {
                  if (runtimeLockedByAgent) {
                    return;
                  }
                  setSelectedCodexModel(model);
                  savePreferredCodexModel(model);
                },
              }}
              opencodeModel={{
                value: runtimeProvider === 'opencode' ? runtimeOpencodeModel : selectedOpencodeModel,
                options: opencodeModelOptions,
                runtimeModel: activeSession?.provider === 'opencode' ? activeSession.model || selectedOpencodeModel : null,
                onChange: (model) => {
                  if (runtimeLockedByAgent) {
                    return;
                  }
                  setSelectedOpencodeModel(model);
                  savePreferredOpencodeModel(model);
                },
              }}
            />

              {runtimeProvider === 'claude' && (
                <ReasoningTraitsPicker
                  value={selectedClaudeReasoningEffort}
                  options={claudeReasoningOptions}
                  defaultEffort="high"
                  onEffortChange={(effort) => {
                    setSelectedClaudeReasoningEffort(effort);
                    savePreferredClaudeReasoningEffort(resolvedSelectedClaudeModel, effort);
                  }}
                  disabled={isBusy || runtimeLockedByAgent}
                />
              )}

              {runtimeProvider === 'codex' && (
                <ReasoningTraitsPicker
                  value={selectedCodexReasoningEffort}
                  options={codexReasoningOptions}
                  defaultEffort={codexDefaultReasoningEffort}
                  onEffortChange={(effort) => {
                    setSelectedCodexReasoningEffort(effort);
                    savePreferredCodexReasoningEffort(resolvedSelectedCodexModel, effort);
                  }}
                  fastMode={
                    codexFastModeSupported
                      ? {
                          enabled: selectedCodexFastMode,
                          onToggle: (enabled) => {
                            setSelectedCodexFastMode(enabled);
                            savePreferredCodexFastMode(codexModelConfig, resolvedSelectedCodexModel, enabled);
                          },
                        }
                      : undefined
                  }
                  disabled={isBusy || runtimeLockedByAgent}
                />
              )}

              {runtimeProvider === 'claude' && runtimeClaudeExecutionMode === 'plan' ? (
                <PlanModeBadge
                  onDisable={() => setSelectedClaudeExecutionMode('execute')}
                  disabled={isBusy || runtimeLockedByAgent}
                />
              ) : null}

              {runtimeProvider === 'codex' && runtimeCodexExecutionMode === 'plan' ? (
                <PlanModeBadge
                  onDisable={() => {
                    setSelectedCodexExecutionMode('execute');
                    savePreferredCodexExecutionMode('execute');
                  }}
                  disabled={isBusy || runtimeLockedByAgent}
                />
              ) : null}

              <SavePromptButton content={promptLibraryContent} disabled={isBusy} />

              <div className="relative">
                <button
                onClick={() => setMenuOpen((v) => !v)}
                disabled={isBusy}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                title="Add"
                aria-label="Add"
              >
                  <Plus className="h-4 w-4" />
                </button>

                {menuOpen && !isBusy && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="popover-surface absolute bottom-full mb-2 left-0 z-30 min-w-[260px] p-1.5">
                      <button
                        onClick={async () => {
                          setMenuOpen(false);
                          await handleAddAttachments();
                        }}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                      >
                        <span className="flex items-center gap-3">
                          <Paperclip className="h-4 w-4" />
                          <span>Add files or photos</span>
                        </span>
                      </button>
                      {activeSession?.scope !== 'dm' && projectAgentProfiles.length > 0 ? (
                        <>
                          <div className="my-1 h-px bg-[var(--border)]/70" />
                          <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">
                            <Users className="h-3.5 w-3.5" />
                            <span>Assign next message</span>
                          </div>
                          <div className="max-h-52 overflow-y-auto">
                            {projectAgentProfiles.map((profile) => {
                              const handle = getAgentMentionHandle(profile);
                              const selected = selectedTaskAgentId === profile.id;
                              return (
                                <button
                                  key={profile.id}
                                  onClick={() => {
                                    setSelectedTaskAgentId(selected ? null : profile.id);
                                    setMenuOpen(false);
                                  }}
                                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                                    selected
                                      ? 'bg-[var(--accent-light)] text-[var(--text-primary)]'
                                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                                  }`}
                                >
                                  <AgentAvatar profile={profile} size="sm" decorative />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[12px] font-medium">
                                      @{handle}
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--text-muted)]">
                                      {profile.role.trim() || 'Agent'} · {getAgentProviderLabel(profile.provider)}
                                    </div>
                                  </div>
                                  {selected ? (
                                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      ) : null}
                      {!runtimeLockedByAgent && (runtimeProvider === 'claude' || runtimeProvider === 'codex') ? (
                        <>
                          <div className="my-1 h-px bg-[var(--border)]/70" />
                          <PlanModeMenuItem
                            providerLabel={runtimeProvider === 'codex' ? 'Codex' : 'Claude'}
                            active={
                              runtimeProvider === 'codex'
                                ? selectedCodexExecutionMode === 'plan'
                                : selectedClaudeExecutionMode === 'plan'
                            }
                            onChange={(active) => {
                              if (runtimeProvider === 'codex') {
                                const nextMode = active ? 'plan' : 'execute';
                                setSelectedCodexExecutionMode(nextMode);
                                savePreferredCodexExecutionMode(nextMode);
                              } else {
                                setSelectedClaudeExecutionMode(active ? 'plan' : 'execute');
                              }
                              setMenuOpen(false);
                            }}
                          />
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {isRunning ? (
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
                disabled={(!prompt.trim() && attachments.length === 0) || isBusy}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105 disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100"
                title="Send"
                aria-label="Send"
              >
                  <ArrowUpIcon />
                </button>
              )}
            </div>
          </div>
          </div>
        </div>
        {(runtimeProvider === 'claude' || runtimeProvider === 'codex' || runtimeProvider === 'opencode') && (
          <div className="flex items-center justify-start px-4 pt-2 text-[12px]">
            {runtimeProvider === 'claude' ? (
              <div className="flex items-center gap-4">
                <ClaudeAccessModePicker
                  value={runtimeClaudeAccessMode}
                  onChange={(mode) => {
                    if (runtimeLockedByAgent) {
                      return;
                    }
                    setSelectedClaudeAccessMode(mode);
                  }}
                  disabled={isBusy || runtimeLockedByAgent}
                />
              </div>
            ) : runtimeProvider === 'codex' ? (
              <div className="flex items-center gap-4">
                <CodexPermissionModePicker
                  value={runtimeCodexPermissionMode}
                  onChange={(mode) => {
                    if (runtimeLockedByAgent) {
                      return;
                    }
                    setSelectedCodexPermissionMode(mode);
                    savePreferredCodexPermissionMode(mode);
                  }}
                  disabled={isBusy || runtimeLockedByAgent}
                />
              </div>
            ) : (
              <CodexPermissionModePicker
                value={runtimeOpencodePermissionMode}
                onChange={(mode) => {
                  if (runtimeLockedByAgent) {
                    return;
                  }
                  setSelectedOpencodePermissionMode(mode);
                  savePreferredOpencodePermissionMode(mode);
                }}
                disabled={isBusy || runtimeLockedByAgent}
              />
            )}
          </div>
        )}
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
