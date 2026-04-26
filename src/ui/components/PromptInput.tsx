import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Paperclip, Plus, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type {
  Attachment,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeCompatibleProviderId,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenCodePermissionMode,
} from '../types';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeAccessModePicker } from './ClaudeAccessModePicker';
import { ClaudeExecutionModePicker } from './ClaudeExecutionModePicker';
import { CodexFastModeToggle } from './CodexFastModeToggle';
import { CodexReasoningEffortPicker } from './CodexReasoningEffortPicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { SavePromptButton } from './prompts/SavePromptButton';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useOpencodeRuntimeStatus } from '../hooks/useOpencodeRuntimeStatus';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getSessionModel } from '../utils/session-model';
import {
  buildClaudeModelOptions,
  formatClaudeModelLabel,
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
  buildCodexModelOptions,
  formatCodexModelLabel,
  loadPreferredCodexModel,
  resolveCodexModel,
  savePreferredCodexModel,
} from '../utils/codex-model';
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
  const [selectedCodexPermissionMode, setSelectedCodexPermissionMode] = useState<CodexPermissionMode>(
    loadPreferredCodexPermissionMode()
  );
  const [selectedCodexReasoningEffort, setSelectedCodexReasoningEffort] =
    useState<CodexReasoningEffort>('medium');
  const [selectedCodexFastMode, setSelectedCodexFastMode] = useState(false);
  const [selectedOpencodePermissionMode, setSelectedOpencodePermissionMode] =
    useState<OpenCodePermissionMode>(loadPreferredOpencodePermissionMode());
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const targetSessionId = sessionId ?? activeSessionId;

  const activeSession = targetSessionId ? sessions[targetSessionId] : null;
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
    () => (provider === 'claude' ? activeSession?.model || getSessionModel(activeSession?.messages) : null),
    [provider, activeSession?.messages, activeSession?.model]
  );
  const visibleActiveClaudeModel = useMemo(() => {
    if (!isVisibleClaudePickerModel(activeSession?.model, compatibleOptions)) {
      return isVisibleClaudePickerModel(activeClaudeModel, compatibleOptions) ? activeClaudeModel.trim() : null;
    }

    return activeSession.model.trim();
  }, [activeClaudeModel, activeSession?.model, compatibleOptions]);
  const handleAutoSubmitClaudeCommand = (nextPrompt: string) => {
    if (!targetSessionId || !activeSession || activeSession.isDraft) {
      setPrompt(nextPrompt);
      return;
    }

    setMenuOpen(false);
    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId: targetSessionId,
        prompt: nextPrompt,
        provider,
        model:
          provider === 'claude'
            ? selectedClaudeModel || claudeModelConfig.defaultModel || undefined
            : provider === 'codex'
              ? resolvedSelectedCodexModel || undefined
              : provider === 'opencode'
                ? selectedOpencodeModel || opencodeModelOptions[0] || undefined
                : undefined,
        compatibleProviderId:
          provider === 'claude' ? selectedClaudeCompatibleProviderId || undefined : undefined,
        betas:
          provider === 'claude' &&
          supportsClaude1mContext(selectedClaudeModel || claudeModelConfig.defaultModel || null) &&
          selectedClaudeContext1m
            ? ['context-1m-2025-08-07']
            : undefined,
        claudeAccessMode: provider === 'claude' ? selectedClaudeAccessMode : undefined,
        claudeExecutionMode: provider === 'claude' ? selectedClaudeExecutionMode : undefined,
        codexPermissionMode: provider === 'codex' ? selectedCodexPermissionMode : undefined,
        codexReasoningEffort:
          provider === 'codex' ? selectedCodexReasoningEffort : undefined,
        codexFastMode:
          provider === 'codex' ? selectedCodexFastMode : undefined,
        opencodePermissionMode:
          provider === 'opencode' ? selectedOpencodePermissionMode : undefined,
      },
    });
    setPrompt('');
    setAttachments([]);
  };
  const skillAutocomplete = useClaudeSkillAutocomplete({
    enabled: true,
    enableSkills: true,
    provider,
    prompt,
    projectPath: activeSession?.cwd,
    sessionMessages: activeSession?.messages || [],
    setPrompt,
    setCursorIndex,
    onAutoSubmitCommand: handleAutoSubmitClaudeCommand,
  });
  const projectFileMentions = useProjectFileMentions({
    cwd: activeSession?.cwd,
    prompt: skillAutocomplete.displayPrompt,
    cursorIndex,
  });
  const promptLibraryContent = useMemo(() => prompt.trim(), [prompt]);

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
    if (activeSession?.provider === 'claude') {
      setSelectedClaudeAccessMode(activeSession.claudeAccessMode || 'default');
      setSelectedClaudeExecutionMode(activeSession.claudeExecutionMode || 'execute');
      return;
    }

    if (!targetSessionId) {
      setSelectedClaudeAccessMode('default');
      setSelectedClaudeExecutionMode('execute');
    }
  }, [activeSession?.claudeAccessMode, activeSession?.claudeExecutionMode, activeSession?.provider, targetSessionId]);

  useEffect(() => {
    if (activeSession?.provider === 'codex') {
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
      setSelectedCodexPermissionMode(loadPreferredCodexPermissionMode());
    }
  }, [
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
        provider === 'claude'
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
      });
    }

    return buildPromptWithProjectFileMentions({
      cwd: activeSession?.cwd || null,
      prompt: trimmedPrompt,
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
    const outgoingEffectivePrompt = promptWithAttachment.converted
      ? promptWithAttachment.prompt
      : normalizedPrompt;
    const outgoingAttachments = promptWithAttachment.attachments;
    if (promptWithAttachment.reason === 'attachment_create_failed') {
      toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
    }

    if (targetSessionId && activeSession?.isDraft) {
      if (!activeSession.cwd?.trim()) {
        toast.error('Select a project folder before starting a task.');
        return;
      }

      setPendingStart(true);
      useAppStore.setState({ pendingDraftSessionId: targetSessionId });
      sendEvent({
        type: 'session.start',
        payload: {
          title: activeSession.title || 'New Chat',
          prompt: outgoingPrompt,
          effectivePrompt: outgoingEffectivePrompt,
          cwd: activeSession.cwd,
          todoState: activeSession.todoState || 'todo',
          attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
          provider,
          model:
            provider === 'claude'
              ? selectedClaudeModel || claudeModelConfig.defaultModel || undefined
              : provider === 'codex'
                ? resolvedSelectedCodexModel || undefined
                : provider === 'opencode'
                  ? selectedOpencodeModel || opencodeModelOptions[0] || undefined
                  : undefined,
          compatibleProviderId:
            provider === 'claude' ? selectedClaudeCompatibleProviderId || undefined : undefined,
          betas:
            provider === 'claude' &&
            supportsClaude1mContext(selectedClaudeModel || claudeModelConfig.defaultModel || null) &&
            selectedClaudeContext1m
              ? ['context-1m-2025-08-07']
              : undefined,
          claudeAccessMode: provider === 'claude' ? selectedClaudeAccessMode : undefined,
          claudeExecutionMode: provider === 'claude' ? selectedClaudeExecutionMode : undefined,
          codexPermissionMode: provider === 'codex' ? selectedCodexPermissionMode : undefined,
          codexReasoningEffort:
            provider === 'codex' ? selectedCodexReasoningEffort : undefined,
          codexFastMode:
            provider === 'codex' ? selectedCodexFastMode : undefined,
          opencodePermissionMode:
            provider === 'opencode' ? selectedOpencodePermissionMode : undefined,
        },
      });
      setPrompt('');
      setAttachments([]);
    } else if (targetSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
            sessionId: targetSessionId,
          prompt: outgoingPrompt,
          effectivePrompt: outgoingEffectivePrompt,
          attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
          provider,
          model:
            provider === 'claude'
              ? selectedClaudeModel || claudeModelConfig.defaultModel || undefined
              : provider === 'codex'
                ? selectedCodexModel || codexModelOptions[0] || undefined
                : provider === 'opencode'
                  ? selectedOpencodeModel || opencodeModelOptions[0] || undefined
                  : undefined,
          compatibleProviderId:
            provider === 'claude' ? selectedClaudeCompatibleProviderId || undefined : undefined,
          betas:
            provider === 'claude' &&
            supportsClaude1mContext(selectedClaudeModel || claudeModelConfig.defaultModel || null) &&
            selectedClaudeContext1m
              ? ['context-1m-2025-08-07']
              : undefined,
          claudeAccessMode: provider === 'claude' ? selectedClaudeAccessMode : undefined,
          claudeExecutionMode: provider === 'claude' ? selectedClaudeExecutionMode : undefined,
          codexPermissionMode: provider === 'codex' ? selectedCodexPermissionMode : undefined,
          codexReasoningEffort:
            provider === 'codex' ? selectedCodexReasoningEffort : undefined,
          codexFastMode:
            provider === 'codex' ? selectedCodexFastMode : undefined,
          opencodePermissionMode:
            provider === 'opencode' ? selectedOpencodePermissionMode : undefined,
        },
      });
      setPrompt('');
      setAttachments([]);
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
        <div className="group relative rounded-[28px] bg-[var(--border)]/45 p-px transition-colors duration-200 focus-within:bg-[var(--border)]/70">
          {projectFileMentions.hasMentionQuery ? (
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
          <div className="rounded-[26px] border border-[var(--border)]/65 bg-[var(--bg-primary)] transition-colors duration-200">
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
              <AgentModelPicker
              provider={provider}
              onProviderChange={(next) => {
                setProvider(next);
                savePreferredProvider(next);
              }}
              disabled={isBusy}
              claudeModel={{
                value: selectedClaudeModel,
                compatibleProviderId: selectedClaudeCompatibleProviderId,
                config: claudeModelConfig,
                runtimeModel: visibleActiveClaudeModel,
                runtimeCompatibleProviderId:
                  activeSession?.provider === 'claude' ? activeSession.compatibleProviderId || null : null,
                context1m: selectedClaudeContext1m,
                compatibleOptions,
                onToggleContext1m: (enabled) => {
                  setSelectedClaudeContext1m(enabled);
                  savePreferredClaudeContext1m(enabled);
                },
                onChange: (model, compatibleProviderId) => {
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
                value: selectedCodexModel,
                options: codexModelOptions,
                runtimeModel:
                  activeSession?.provider === 'codex'
                    ? resolveCodexModel(activeSession.model || selectedCodexModel, codexModelConfig)
                    : null,
                onChange: (model) => {
                  setSelectedCodexModel(model);
                  savePreferredCodexModel(model);
                },
              }}
              opencodeModel={{
                value: selectedOpencodeModel,
                options: opencodeModelOptions,
                runtimeModel: activeSession?.provider === 'opencode' ? activeSession.model || selectedOpencodeModel : null,
                onChange: (model) => {
                  setSelectedOpencodeModel(model);
                  savePreferredOpencodeModel(model);
                },
              }}
            />

              {provider === 'codex' && (
                <div className="flex items-center gap-3">
                <CodexReasoningEffortPicker
                  value={selectedCodexReasoningEffort}
                  options={codexReasoningOptions}
                  onChange={(effort) => {
                    setSelectedCodexReasoningEffort(effort);
                    savePreferredCodexReasoningEffort(selectedCodexModel, effort);
                  }}
                  disabled={isBusy}
                />
                {codexFastModeSupported && (
                  <CodexFastModeToggle
                    enabled={selectedCodexFastMode}
                      onToggle={(enabled) => {
                        setSelectedCodexFastMode(enabled);
                        savePreferredCodexFastMode(codexModelConfig, selectedCodexModel, enabled);
                      }}
                    disabled={isBusy}
                  />
                )}
                </div>
              )}

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
                    <div className="popover-surface absolute bottom-full mb-2 left-0 z-30 min-w-[220px] p-1.5">
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
        {(provider === 'claude' || provider === 'codex' || provider === 'opencode') && (
          <div className="flex items-center justify-start px-4 pt-2 text-[12px]">
            {provider === 'claude' ? (
              <div className="flex items-center gap-4">
                <ClaudeExecutionModePicker
                  value={selectedClaudeExecutionMode}
                  onChange={setSelectedClaudeExecutionMode}
                  disabled={isBusy}
                />
                <ClaudeAccessModePicker
                  value={selectedClaudeAccessMode}
                  onChange={setSelectedClaudeAccessMode}
                  disabled={isBusy}
                />
              </div>
            ) : provider === 'codex' ? (
              <CodexPermissionModePicker
                value={selectedCodexPermissionMode}
                onChange={(mode) => {
                  setSelectedCodexPermissionMode(mode);
                  savePreferredCodexPermissionMode(mode);
                }}
                disabled={isBusy}
              />
            ) : (
              <CodexPermissionModePicker
                value={selectedOpencodePermissionMode}
                onChange={(mode) => {
                  setSelectedOpencodePermissionMode(mode);
                  savePreferredOpencodePermissionMode(mode);
                }}
                disabled={isBusy}
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
