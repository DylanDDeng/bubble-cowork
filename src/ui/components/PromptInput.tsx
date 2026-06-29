import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { Plus, Square } from './icons';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { ClaudeContextIndicator } from './ClaudeContextIndicator';
import { CodexContextIndicator } from './CodexContextIndicator';
import { OpenCodeContextIndicator } from './OpenCodeContextIndicator';
import { ComposerAgentModelPicker } from './ComposerAgentControls';
import { ClaudePermissionModePicker } from './ClaudePermissionModePicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { KimiPermissionModePicker } from './KimiPermissionModePicker';
import { OpenCodePermissionModePicker } from './OpenCodePermissionModePicker';
import { useComposerAgentSelection } from '../hooks/useComposerAgentSelection';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { buildCodexReferencePayload } from '../utils/codex-composer';
import { insertProjectFileMention } from '../utils/project-file-mentions';
import { buildPromptWithProjectFileMentions } from '../utils/project-file-mention-context';
import {
  getLongPromptAttachmentFallbackMessage,
  LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD,
  maybeConvertLongPromptToAttachment,
} from '../utils/long-prompt-attachment';
import {
  buildClaudeContextSnapshot,
  getLatestClaudeContextSnapshot,
  getLatestCodexContextSnapshot,
  getLatestOpenCodeContextSnapshot,
  getContextLevelColorVar,
  getContextUsageLevel,
  isClaudeUsageModelMatch,
  CONTEXT_CRITICAL_PERCENT,
} from '../utils/context-usage';

function isImeComposingEvent(
  event: ReactKeyboardEvent,
  isComposingRef: MutableRefObject<boolean>
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
  menuSide = 'top',
  composerSurface = 'chat',
  footer,
}: {
  sessionId?: string | null;
  approvalPending?: boolean;
  approvalPanel?: ReactNode;
  /** Which side the model/permission menus open toward. The bottom-anchored
   * chat composer keeps 'top'; the centered new-thread landing passes 'bottom'. */
  menuSide?: 'top' | 'bottom';
  /** 'chat' is the bottom composer (large rounded pill, no tray). 'landing'
   * wraps the input in a subtle gray tray that also holds `footer`, matching
   * the new-thread first-entry composer. */
  composerSurface?: 'chat' | 'landing';
  /** Content rendered inside the composer tray, below the input (landing only) —
   * e.g. the project / branch context pills. */
  footer?: ReactNode;
} = {}) {
  const {
    activeSessionId,
    sessions,
    activeChannelByProject,
    pendingStart,
    setShowNewSession,
    setShowSettings,
    setActiveSettingsTab,
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

  const agentSelection = useComposerAgentSelection({
    selectionKey: activeSession?.id || targetSessionId || '__composer__',
    provider: activeSession?.provider || null,
    model: activeSession?.model || null,
    compatibleProviderId: activeSession?.compatibleProviderId || null,
    claudePermissionMode:
      activeSession?.provider === 'claude' ? activeSession.claudeAccessMode || null : null,
    opencodePermissionMode:
      activeSession?.provider === 'opencode' ? activeSession.opencodePermissionMode || null : null,
    claudeReasoningEffort:
      activeSession?.provider === 'claude' ? activeSession.claudeReasoningEffort || null : null,
  });
  const runtimeProvider = agentSelection.provider;
  const selectedModel = agentSelection.model;
  const selectedModelLabel = agentSelection.selectedModelLabel;
  const modelSetupRequired = Boolean(agentSelection.modelSetup);
  const isClaudeContextVisible = runtimeProvider === 'claude' && activeSession?.provider === 'claude';
  const isCodexContextVisible = runtimeProvider === 'codex' && activeSession?.provider === 'codex';
  const isOpenCodeContextVisible = runtimeProvider === 'opencode' && activeSession?.provider === 'opencode';
  const isPiContextVisible = runtimeProvider === 'pi' && activeSession?.provider === 'pi';
  const claudeContextModel = isClaudeContextVisible ? selectedModel || activeSession?.model || null : null;
  const openCodeContextModel = isOpenCodeContextVisible ? selectedModel || activeSession?.model || null : null;
  const piContextModel = isPiContextVisible ? selectedModel || activeSession?.model || null : null;

  const codexContextSnapshot = useMemo(
    () =>
      isCodexContextVisible
        ? getLatestCodexContextSnapshot(activeSession.messages)
        : null,
    [activeSession?.messages, isCodexContextVisible]
  );
  const claudeContextSnapshot = useMemo(() => {
    if (!isClaudeContextVisible) {
      return null;
    }
    const latestFromMessages = getLatestClaudeContextSnapshot(activeSession.messages, claudeContextModel);
    if (latestFromMessages) {
      return latestFromMessages;
    }
    const latestUsage = activeSession.latestClaudeModelUsage;
    return latestUsage && isClaudeUsageModelMatch(latestUsage.model, claudeContextModel)
      ? buildClaudeContextSnapshot(latestUsage.model, latestUsage.usage)
      : null;
  }, [
    claudeContextModel,
    activeSession?.latestClaudeModelUsage,
    activeSession?.messages,
    isClaudeContextVisible,
  ]);
  const openCodeContextSnapshot = useMemo(
    () =>
      isOpenCodeContextVisible
        ? getLatestOpenCodeContextSnapshot(activeSession.messages, openCodeContextModel)
        : null,
    [activeSession?.messages, isOpenCodeContextVisible, openCodeContextModel]
  );
  const piContextSnapshot = useMemo(
    () =>
      isPiContextVisible
        ? getLatestOpenCodeContextSnapshot(activeSession.messages, piContextModel, 'Pi')
        : null,
    [activeSession?.messages, isPiContextVisible, piContextModel]
  );
  const contextWarning = useMemo(() => {
    // Claude auto-compacts near the limit; Codex/OpenCode/Pi do not, so the copy differs.
    let percent = 0;
    let total = 0;
    let autoCompacts = false;
    if (claudeContextSnapshot) {
      percent = claudeContextSnapshot.percent;
      total = claudeContextSnapshot.total || 0;
      autoCompacts = true;
    } else if (codexContextSnapshot) {
      percent = codexContextSnapshot.percent;
      total = codexContextSnapshot.total || 0;
      autoCompacts = false;
    } else if (openCodeContextSnapshot) {
      percent = openCodeContextSnapshot.percent;
      total = openCodeContextSnapshot.total || 0;
      autoCompacts = false;
    } else if (piContextSnapshot) {
      percent = piContextSnapshot.percent;
      total = piContextSnapshot.total || 0;
      autoCompacts = false;
    } else {
      return null;
    }
    if (total <= 0) {
      return null;
    }
    const level = getContextUsageLevel(percent);
    if (level === 'safe') {
      return null;
    }
    const color = getContextLevelColorVar(level);
    const message = autoCompacts
      ? percent >= CONTEXT_CRITICAL_PERCENT
        ? `上下文已用 ${percent}% · 较早的对话即将被自动压缩为摘要`
        : `上下文已用 ${percent}% · 接近上限，稍后会自动压缩较早的对话`
      : percent >= CONTEXT_CRITICAL_PERCENT
        ? `上下文已用 ${percent}% · 已接近上下文窗口上限`
        : `上下文已用 ${percent}% · 接近上下文窗口上限`;
    return { color, message };
  }, [claudeContextSnapshot, codexContextSnapshot, openCodeContextSnapshot, piContextSnapshot]);

  const isRunning = activeSession?.status === 'running';
  const isBusy = isRunning || pendingStart || approvalPending;

  const capabilityMenu = useComposerCapabilityMenu({
    enabled: Boolean(activeSession),
    enableSkills: true,
    provider: runtimeProvider,
    prompt,
    cursorIndex,
    projectPath: activeSession?.cwd,
    sessionMessages: activeSession?.messages || [],
    setPrompt,
    setCursorIndex,
  });

  const projectFileMentions = useProjectFileMentions({
    cwd: activeSession?.cwd,
    prompt,
    cursorIndex,
  });

  const resetComposer = useCallback(() => {
    setPrompt('');
    setCursorIndex(0);
    setAttachments([]);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setCursorIndex(0);
    });
  }, []);

  const openModelSetup = useCallback(() => {
    const setup = agentSelection.modelSetup;
    if (!setup) {
      return;
    }
    setActiveSettingsTab(setup.settingsTab);
    setShowSettings(true);
  }, [agentSelection.modelSetup, setActiveSettingsTab, setShowSettings]);

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

  const buildDispatchPrompt = async (): Promise<string | null> => {
    const selectedSkillPrompt =
      capabilityMenu.selectedSkill && runtimeProvider === 'codex'
        ? capabilityMenu.selectedSkillRemainder.trim()
        : prompt.trim();

    return buildPromptWithProjectFileMentions({
      cwd: activeSession?.cwd || null,
      prompt: selectedSkillPrompt,
      ignoredMentionPaths: [],
    });
  };

  const autoConvertComposerTextToAttachment = useCallback(async (
    value: string,
    nextCursorIndex: number
  ): Promise<boolean> => {
    if (isComposingRef.current) {
      setPrompt(value);
      setCursorIndex(nextCursorIndex);
      return false;
    }

    if (value.trim().length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) {
      setPrompt(value);
      setCursorIndex(nextCursorIndex);
      return false;
    }

    const promptWithAttachment = await maybeConvertLongPromptToAttachment({
      cwd: activeSession?.cwd || null,
      prompt: value,
      attachments,
    });

    if (!promptWithAttachment.converted) {
      setPrompt(value);
      setCursorIndex(nextCursorIndex);
      if (promptWithAttachment.reason === 'attachment_create_failed') {
        toast.error('Failed to convert the long message into an attachment.');
      }
      return false;
    }

    setAttachments(promptWithAttachment.attachments);
    setPrompt('');
    setCursorIndex(0);
    window.requestAnimationFrame(() => editorRef.current?.focus());
    return true;
  }, [activeSession?.cwd, attachments]);

  const handleSend = async () => {
    if (!prompt.trim() && attachments.length === 0) return;
    if (agentSelection.modelSetup) {
      toast.error(agentSelection.modelSetup.title);
      openModelSetup();
      return;
    }
    if (!activeSession) {
      setShowNewSession(true);
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
    const outgoingEffectivePrompt = promptWithAttachment.converted
      ? promptWithAttachment.prompt
      : normalizedPrompt;
    const outgoingAttachments = promptWithAttachment.attachments;
    if (promptWithAttachment.reason === 'attachment_create_failed') {
      toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
    }
    const codexReferences =
      runtimeProvider === 'codex'
        ? buildCodexReferencePayload(capabilityMenu.selectedSkill)
        : {};
    if (activeSession.isDraft) {
      if (!activeSession.cwd?.trim()) {
        toast.error('Select a project folder before starting a task.');
        return;
      }

      setPendingStart(true);
      useAppStore.setState({ pendingDraftSessionId: activeSession.id });
      const projectKey = (activeSession.cwd || '').trim() || '__no_project__';
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
          cwd: activeSession.cwd,
          projectCwd: activeSession.projectCwd ?? activeSession.cwd ?? null,
          envMode: activeSession.envMode ?? 'local',
          worktreePath: activeSession.worktreePath ?? null,
          associatedWorktreePath: activeSession.associatedWorktreePath ?? null,
          associatedWorktreeBranch: activeSession.associatedWorktreeBranch ?? null,
          associatedWorktreeRef: activeSession.associatedWorktreeRef ?? null,
          scope: 'project',
          channelId,
          attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
          provider: runtimeProvider,
          model: selectedModel || undefined,
          compatibleProviderId:
            runtimeProvider === 'claude' ? agentSelection.compatibleProviderId || undefined : undefined,
          claudeAccessMode:
            runtimeProvider === 'claude'
              ? agentSelection.claudePermissionMode
              : undefined,
          claudeExecutionMode:
            runtimeProvider === 'claude' && agentSelection.claudePermissionMode === 'plan'
              ? 'plan'
              : runtimeProvider === 'claude'
                ? 'execute'
                : undefined,
          claudeReasoningEffort:
            runtimeProvider === 'claude'
              ? agentSelection.claudeReasoningEffort || undefined
              : undefined,
          ...codexReferences,
          codexPermissionMode:
            runtimeProvider === 'codex'
              ? agentSelection.codexPermissionMode
              : undefined,
          kimiPermissionMode:
            runtimeProvider === 'kimi' || runtimeProvider === 'grok'
              ? agentSelection.kimiPermissionMode
              : undefined,
          opencodePermissionMode:
            runtimeProvider === 'opencode'
              ? agentSelection.opencodePermissionMode
              : undefined,
          teamMode: 'solo',
          teamId: null,
        },
      });
      resetComposer();
      return;
    }

    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId: activeSession.id,
        prompt: outgoingPrompt,
        effectivePrompt: outgoingEffectivePrompt,
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
        provider: runtimeProvider,
        model: selectedModel || undefined,
        compatibleProviderId:
          runtimeProvider === 'claude' ? agentSelection.compatibleProviderId || undefined : undefined,
        claudeAccessMode:
          runtimeProvider === 'claude'
            ? agentSelection.claudePermissionMode
            : undefined,
        claudeExecutionMode:
          runtimeProvider === 'claude' && agentSelection.claudePermissionMode === 'plan'
            ? 'plan'
            : runtimeProvider === 'claude'
              ? 'execute'
              : undefined,
        claudeReasoningEffort:
          runtimeProvider === 'claude'
            ? agentSelection.claudeReasoningEffort || undefined
            : undefined,
        ...codexReferences,
        codexPermissionMode:
          runtimeProvider === 'codex'
            ? agentSelection.codexPermissionMode
            : undefined,
        kimiPermissionMode:
          runtimeProvider === 'kimi' || runtimeProvider === 'grok'
            ? agentSelection.kimiPermissionMode
            : undefined,
        opencodePermissionMode:
          runtimeProvider === 'opencode'
            ? agentSelection.opencodePermissionMode
            : undefined,
        teamMode: 'solo',
        teamId: null,
      },
    });
    resetComposer();
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

  const handleSelectProjectFile = useCallback(
    async (file: { path: string; relativePath?: string }) => {
      const cwd = activeSession?.cwd;
      const mention = projectFileMentions.mention;
      if (!cwd || !mention) {
        return;
      }

      const next = insertProjectFileMention(
        prompt,
        mention,
        file.relativePath || file.path
      );
      setPrompt(next.prompt);
      setCursorIndex(next.cursorIndex);
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setCursorIndex(next.cursorIndex);
      });
    },
    [activeSession?.cwd, projectFileMentions.mention, prompt]
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

    const pasteInline = () => {
      const nextPrompt = `${prompt.slice(0, context.start)}${context.text}${prompt.slice(context.end)}`;
      const nextCursorIndex = context.start + context.text.length;
      setPrompt(nextPrompt);
      setCursorIndex(nextCursorIndex);
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
        editorRef.current?.setCursorIndex(nextCursorIndex);
      });
    };

    const toastId = toast.loading('Creating text attachment...');
    void (async () => {
      try {
        const promptWithAttachment = await maybeConvertLongPromptToAttachment({
          cwd: activeSession?.cwd || null,
          prompt: pastedText,
          attachments,
          allowProjectMentions: true,
        });

        if (!promptWithAttachment.converted) {
          pasteInline();
          toast.error(getLongPromptAttachmentFallbackMessage(promptWithAttachment.reason), {
            id: toastId,
          });
          return;
        }

        const nextPrompt = `${prompt.slice(0, context.start)}${prompt.slice(context.end)}`;
        setAttachments(promptWithAttachment.attachments);
        setPrompt(nextPrompt);
        setCursorIndex(context.start);
        toast.dismiss(toastId);
        window.requestAnimationFrame(() => {
          editorRef.current?.focus();
          editorRef.current?.setCursorIndex(context.start);
        });
      } catch {
        pasteInline();
        toast.error('Could not create a text attachment. Pasted inline instead.', {
          id: toastId,
        });
        return;
      }
    })();

    return true;
  }, [activeSession?.cwd, attachments, prompt]);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
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

    if (capabilityMenu.hasSlashQuery) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        capabilityMenu.moveSelection(1);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        capabilityMenu.moveSelection(-1);
        return;
      }

      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        capabilityMenu.suggestions.length > 0
      ) {
        e.preventDefault();
        capabilityMenu.selectCurrentSuggestion();
        window.requestAnimationFrame(() => editorRef.current?.focus());
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isRunning) {
        handleStop();
      } else if (!isBusy && !modelSetupRequired) {
        handleSend();
      }
    }
  };

  const isLandingSurface = composerSurface === 'landing';
  // Landing: a flat gray tray (recessed) with the white input box raised on top
  // via its own shadow; the tray only shows below the box, holding the pills.
  const composerOuterClass = isLandingSurface
    ? 'group relative rounded-[18px] bg-[var(--bg-secondary)] shadow-[0_2px_8px_rgba(15,23,42,0.04)]'
    : 'group relative rounded-[28px] bg-transparent transition-shadow duration-200';
  const composerInnerClass = isLandingSurface
    ? 'rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_4px_16px_rgba(15,23,42,0.08)]'
    : 'rounded-[26px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)] transition-[border-color,box-shadow] duration-200 focus-within:border-[color-mix(in_srgb,var(--border)_92%,transparent)] focus-within:shadow-[0_20px_52px_rgba(15,23,42,0.12)]';

  return (
    <div className="bg-transparent">
      <div className="mx-auto max-w-4xl">
        {contextWarning ? (
          <div
            className="mb-2 flex items-center gap-2 rounded-[12px] px-3 py-1.5 text-[12px] leading-4"
            style={{
              color: contextWarning.color,
              backgroundColor: `color-mix(in srgb, ${contextWarning.color} 10%, transparent)`,
              border: `1px solid color-mix(in srgb, ${contextWarning.color} 28%, transparent)`,
            }}
            role="status"
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: contextWarning.color }}
            />
            <span className="min-w-0 truncate">{contextWarning.message}</span>
          </div>
        ) : null}
        <div className={composerOuterClass}>
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
          ) : capabilityMenu.hasSlashQuery ? (
            <div className="absolute inset-x-0 bottom-full z-40">
              <ClaudeSkillMenu
                suggestions={capabilityMenu.suggestions}
                selectedIndex={capabilityMenu.selectedIndex}
                empty={capabilityMenu.suggestions.length === 0}
                title={capabilityMenu.menuTitle}
                emptyMessage={capabilityMenu.emptyMessage}
                onSelect={(suggestion) => {
                  capabilityMenu.selectSuggestion(suggestion);
                  window.requestAnimationFrame(() => editorRef.current?.focus());
                }}
                onHighlight={capabilityMenu.setSelectedIndex}
              />
            </div>
          ) : null}
          {approvalPending && approvalPanel ? (
            approvalPanel
          ) : (
          <div className={composerInnerClass}>
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
            value={capabilityMenu.displayPrompt}
            cursorIndex={cursorIndex}
            slashContext={capabilityMenu.slashContext}
            slashDisplayLabels={capabilityMenu.slashDisplayLabels}
            agentMentionLabels={{}}
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
                : 'Message the agent...'
            }
            disabled={pendingStart || approvalPending}
            className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50"
            autoFocus={false}
          />

          <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
              <ComposerAgentModelPicker
                agentProvider={runtimeProvider}
                modelLabel={agentSelection.selectedModelLabel}
                modelValue={selectedModel}
                allAgentModelOptions={agentSelection.allAgentModelOptions}
                disabled={isBusy}
                onAgentChange={agentSelection.selectAgent}
                onModelChange={agentSelection.selectModel}
                codexModels={agentSelection.codexModels.length > 0 ? agentSelection.codexModels : undefined}
                claudeReasoningEffort={agentSelection.claudeReasoningEffort ?? undefined}
                onClaudeReasoningEffortChange={agentSelection.setClaudeReasoningEffort}
                codexReasoningEffort={agentSelection.codexReasoningEffort ?? undefined}
                onCodexReasoningEffortChange={agentSelection.setCodexReasoningEffort}
                codexFastMode={agentSelection.codexFastMode}
                onCodexFastModeChange={agentSelection.setCodexFastMode}
                menuSide={menuSide}
              />
              {agentSelection.provider === 'codex' && (
                <CodexPermissionModePicker
                  value={agentSelection.codexPermissionMode}
                  onChange={agentSelection.setCodexPermissionMode}
                  menuSide={menuSide}
                />
              )}
              {agentSelection.provider === 'claude' && (
                <ClaudePermissionModePicker
                  value={agentSelection.claudePermissionMode}
                  onChange={agentSelection.setClaudePermissionMode}
                  disabled={isBusy}
                  menuSide={menuSide}
                />
              )}
              {agentSelection.provider === 'opencode' && (
                <OpenCodePermissionModePicker
                  value={agentSelection.opencodePermissionMode}
                  onChange={agentSelection.setOpencodePermissionMode}
                  disabled={isBusy}
                  menuSide={menuSide}
                />
              )}
              {(agentSelection.provider === 'kimi' || agentSelection.provider === 'grok') && (
                <KimiPermissionModePicker
                  value={agentSelection.kimiPermissionMode}
                  onChange={agentSelection.setKimiPermissionMode}
                  menuSide={menuSide}
                />
              )}
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
              {isClaudeContextVisible ? (
                <ClaudeContextIndicator
                  snapshot={claudeContextSnapshot}
                  modelLabel={selectedModelLabel || claudeContextModel}
                />
              ) : null}
              {codexContextSnapshot ? (
                <CodexContextIndicator snapshot={codexContextSnapshot} />
              ) : null}
              {isOpenCodeContextVisible ? (
                <OpenCodeContextIndicator
                  snapshot={openCodeContextSnapshot}
                  modelLabel={selectedModelLabel || openCodeContextModel}
                />
              ) : null}
              {isPiContextVisible ? (
                <OpenCodeContextIndicator
                  snapshot={piContextSnapshot}
                  modelLabel={selectedModelLabel || piContextModel}
                  providerLabel="Pi"
                />
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
                  isBusy ||
                  modelSetupRequired
                }
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
          )}
          {footer && isLandingSurface ? footer : null}
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
