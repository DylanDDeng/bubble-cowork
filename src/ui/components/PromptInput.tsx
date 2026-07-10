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
import { Plus, Redo2, Square, Trash2 } from './icons';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import {
  selectQueuedMessages,
  useComposerQueueStore,
} from '../store/useComposerQueueStore';
import { useShallow } from 'zustand/react/shallow';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import {
  EMPTY_PROMPT_HISTORY_NAV,
  collectPromptHistory,
  isCursorOnFirstLine,
  remapPromptHistoryNav,
  stepPromptHistory,
  type PromptHistoryNav,
  type PromptHistoryStep,
} from '../utils/prompt-history';
import { ClaudeContextIndicator } from './ClaudeContextIndicator';
import { CodexContextIndicator } from './CodexContextIndicator';
import { OpenCodeContextIndicator } from './OpenCodeContextIndicator';
import { ComposerAgentModelPicker } from './ComposerAgentControls';
import * as Dialog from './ui/dialog';
import { PROVIDERS } from '../utils/provider';
import type { AgentProvider } from '../types';
import { ClaudePermissionModePicker } from './ClaudePermissionModePicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { KimiPermissionModePicker } from './KimiPermissionModePicker';
import { OpenCodePermissionModePicker } from './OpenCodePermissionModePicker';
import { useComposerAgentSelection } from '../hooks/useComposerAgentSelection';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import {
  buildCodexReferencePayload,
  type CodexReferencePayload,
} from '../utils/codex-composer';
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
  getLatestClaudeTurnUsage,
  getLatestCodexContextSnapshot,
  getLatestOpenCodeContextSnapshot,
  isClaudeUsageModelMatch,
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
  // P2: shallow-picked subscription (the composer must not re-render for
  // unrelated store changes); the session itself is a narrow selector below.
  const {
    activeSessionId,
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
    draftStartMode,
    handoffSessionToProvider,
  } = useAppStore(
    useShallow((s) => ({
      activeSessionId: s.activeSessionId,
      activeChannelByProject: s.activeChannelByProject,
      pendingStart: s.pendingStart,
      setShowNewSession: s.setShowNewSession,
      setShowSettings: s.setShowSettings,
      setActiveSettingsTab: s.setActiveSettingsTab,
      setPendingStart: s.setPendingStart,
      promptLibraryInsertRequest: s.promptLibraryInsertRequest,
      consumePromptLibraryInsert: s.consumePromptLibraryInsert,
      pendingChatInjection: s.pendingChatInjection,
      consumeChatInjection: s.consumeChatInjection,
      draftStartMode: s.draftStartMode,
      handoffSessionToProvider: s.handoffSessionToProvider,
    }))
  );
  const [prompt, setPrompt] = useState('');
  // ArrowUp/ArrowDown history navigation. historyNavRef tracks the browsing
  // position + stashed draft; historyAppliedTextRef remembers the last text WE
  // put in the composer, so any user edit detectably exits history mode.
  const historyNavRef = useRef<PromptHistoryNav>(EMPTY_PROMPT_HISTORY_NAV);
  const historyAppliedTextRef = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const targetSessionId = sessionId ?? activeSessionId;
  const activeSession = useAppStore((s) =>
    targetSessionId ? s.sessions[targetSessionId] ?? null : null
  );

  const promptHistory = useMemo(
    () => collectPromptHistory(activeSession?.messages ?? []),
    [activeSession?.messages]
  );

  // Ends an active browse and restores the stashed draft (text AND
  // attachments) into the composer, mirroring the ArrowDown exit — the
  // recalled prompt must never strand in the composer with the draft
  // unrecoverable. Focus is intentionally not forced: these exits are not
  // always key-driven.
  const exitHistoryBrowse = useCallback((nav: PromptHistoryNav) => {
    historyNavRef.current = EMPTY_PROMPT_HISTORY_NAV;
    historyAppliedTextRef.current = null;
    if (nav.index === null) {
      return;
    }
    const draft = nav.draft ?? '';
    setPrompt(draft);
    setCursorIndex(draft.length);
    setAttachments(nav.draftAttachments ?? []);
  }, []);

  // Switching sessions exits history mode (restoring the stashed draft);
  // editing the recalled text exits too, keeping the edit.
  useEffect(() => {
    exitHistoryBrowse(historyNavRef.current);
  }, [exitHistoryBrowse, targetSessionId]);

  useEffect(() => {
    if (
      historyNavRef.current.index !== null &&
      historyAppliedTextRef.current !== null &&
      prompt !== historyAppliedTextRef.current
    ) {
      // Editing the recalled text turns it into a new message that
      // deliberately inherits nothing from the old draft (terminal
      // semantics): the stashed text AND attachments are discarded, matching
      // what sending the recalled entry does.
      historyNavRef.current = EMPTY_PROMPT_HISTORY_NAV;
      historyAppliedTextRef.current = null;
    }
  }, [prompt]);

  // Scrolling the chat pane up lazily PREPENDS older messages (and a rewind
  // can drop entries), shifting promptHistory under an active browse. Re-anchor
  // the stored index to the recalled entry so the next step lands on the right
  // neighbor instead of a drifted position; when the recalled entry vanished
  // entirely the browse exits and the draft comes back.
  useEffect(() => {
    const nav = historyNavRef.current;
    if (nav.index === null) {
      return;
    }
    const remapped = remapPromptHistoryNav(promptHistory, nav, historyAppliedTextRef.current);
    if (remapped.index === null) {
      exitHistoryBrowse(nav);
      return;
    }
    historyNavRef.current = remapped;
  }, [exitHistoryBrowse, promptHistory]);

  const applyPromptHistoryStep = (step: PromptHistoryStep) => {
    historyNavRef.current = step.nav;
    historyAppliedTextRef.current = step.nav.index === null ? null : step.text;
    if (step.clamped) {
      // Hit the oldest entry: the key is swallowed but nothing changed, so
      // leave the text and caret exactly where they are.
      return;
    }
    setPrompt(step.text);
    setCursorIndex(step.text.length);
    if (step.attachments) {
      // Cleared on entry (recalled entries are text-only, so a send never
      // attaches the old draft's files) and restored with the draft on exit.
      setAttachments(step.attachments);
    }
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setCursorIndex(step.text.length);
    });
  };

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
    grokReasoningEffort:
      activeSession?.provider === 'grok' ? activeSession.grokReasoningEffort || null : null,
  });
  const runtimeProvider = agentSelection.provider;
  const selectedModel = agentSelection.model;

  // P3: speculative Claude runner prewarm. The first keystroke for an idle
  // Claude session boots the CLI (spawn + settings + MCP connect + resume
  // replay) while the user is still composing, so the eventual send reuses a
  // live runner instead of paying the cold start in front of the first
  // token. Fired at most once per session per composer mount; the payload
  // mirrors the `session.continue` fields so the main process's reuse check
  // normalizes both identically.
  const prewarmedSessionRef = useRef<string | null>(null);
  // Latest composer config, refreshed every render so the debounced prewarm
  // timer reads current values at fire time (see the effect below).
  const prewarmConfigRef = useRef({
    model: selectedModel,
    compatibleProviderId: agentSelection.compatibleProviderId,
    claudeAccessMode: agentSelection.claudePermissionMode,
    claudeReasoningEffort: agentSelection.claudeReasoningEffort,
  });
  prewarmConfigRef.current = {
    model: selectedModel,
    compatibleProviderId: agentSelection.compatibleProviderId,
    claudeAccessMode: agentSelection.claudePermissionMode,
    claudeReasoningEffort: agentSelection.claudeReasoningEffort,
  };
  const hasComposerActivity = prompt.trim().length > 0;
  useEffect(() => {
    if (!hasComposerActivity || !targetSessionId) return;
    if (runtimeProvider !== 'claude') return;
    if (!activeSession || activeSession.isDraft || activeSession.readOnly) return;
    if (activeSession.status === 'running') return;
    if (prewarmedSessionRef.current === targetSessionId) return;
    const timer = window.setTimeout(() => {
      prewarmedSessionRef.current = targetSessionId;
      // Read config from the ref, not the scheduling render's closure — if the
      // user changes model/mode during the 300ms debounce, the prewarm must
      // carry the LATEST values so the eventual send reuses it (or so the
      // main-process divergence guard skips a doomed prewarm) instead of
      // warming a stale-config runner that the send then aborts.
      const cfg = prewarmConfigRef.current;
      sendEvent({
        type: 'runner.prewarm',
        payload: {
          sessionId: targetSessionId,
          model: cfg.model || undefined,
          compatibleProviderId: cfg.compatibleProviderId || undefined,
          claudeAccessMode: cfg.claudeAccessMode,
          claudeExecutionMode: cfg.claudeAccessMode === 'plan' ? 'plan' : 'execute',
          claudeReasoningEffort: cfg.claudeReasoningEffort || undefined,
        },
      });
    }, 300);
    return () => window.clearTimeout(timer);
    // Config values are intentionally excluded from deps — they're read from
    // prewarmConfigRef at fire time (above), so a change during the debounce
    // does not need to reschedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasComposerActivity,
    targetSessionId,
    runtimeProvider,
    activeSession?.isDraft,
    activeSession?.readOnly,
    activeSession?.status,
  ]);

  // Sessions are locked to their agent once a conversation exists — switching
  // goes through an explicit handoff that carries the transcript to a new
  // session for the target provider (synara-style thread handoff).
  const [handoffTarget, setHandoffTarget] = useState<AgentProvider | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const sessionProviderLocked = Boolean(
    activeSession &&
      !activeSession.isDraft &&
      !activeSession.readOnly &&
      activeSession.provider &&
      (activeSession.messages.length > 0 || activeSession.hydrated === false)
  );
  const handleAgentChange = useCallback(
    (nextProvider: AgentProvider) => {
      if (sessionProviderLocked && activeSession?.provider && nextProvider !== activeSession.provider) {
        setHandoffTarget(nextProvider);
        return;
      }
      agentSelection.selectAgent(nextProvider);
    },
    [activeSession?.provider, agentSelection, sessionProviderLocked]
  );
  const confirmHandoff = useCallback(async () => {
    if (!activeSession || !handoffTarget || handoffBusy) {
      return;
    }
    setHandoffBusy(true);
    try {
      await handoffSessionToProvider(activeSession.id, handoffTarget);
      setHandoffTarget(null);
    } finally {
      setHandoffBusy(false);
    }
  }, [activeSession, handoffBusy, handoffSessionToProvider, handoffTarget]);
  const providerLabel = useCallback(
    (provider: AgentProvider | null | undefined) =>
      PROVIDERS.find((entry) => entry.id === provider)?.label || provider || 'the agent',
    []
  );
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
      ? buildClaudeContextSnapshot(
          latestUsage.model,
          latestUsage.usage,
          getLatestClaudeTurnUsage(activeSession.messages, latestUsage.model)
        )
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
  const isRunning = activeSession?.status === 'running';
  const isBusy = isRunning || pendingStart || approvalPending;
  // Codex app-server supports turn/steer: a message sent while a turn is
  // streaming is injected into that turn instead of waiting for it to finish,
  // so the composer stays live for codex sessions while they run.
  const canSteerWhileRunning =
    runtimeProvider === 'codex' && isRunning && !approvalPending && !modelSetupRequired;
  const queuedMessages = useComposerQueueStore((state) =>
    selectQueuedMessages(state, targetSessionId)
  );

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

  // After a conversation rewind, the rewound-away prompt is offered back to
  // the composer (matching Claude Code's /rewind behavior). Never clobber
  // text the user has already typed.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail;
      if (!detail?.text || detail.sessionId !== targetSessionId) return;
      setPrompt((current) => (current.trim() ? current : detail.text!));
      setCursorIndex(detail.text.length);
      window.requestAnimationFrame(() => editorRef.current?.focus());
    };
    window.addEventListener('aegis-composer-set-prompt', handler);
    return () => window.removeEventListener('aegis-composer-set-prompt', handler);
  }, [targetSessionId]);

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

    // Text recalled from prompt history is exempt from long-prompt conversion:
    // silently swapping a recalled prompt for an attachment would wipe the
    // composer and drop the stashed draft.
    if (historyAppliedTextRef.current !== null && value === historyAppliedTextRef.current) {
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

    // `/rewind` is a local UI command (checkpoint restore), not a prompt for
    // the model: open the rewind dialog instead of dispatching a turn.
    if (
      runtimeProvider === 'claude' &&
      prompt.trim().toLowerCase() === '/rewind' &&
      attachments.length === 0 &&
      activeSession.id
    ) {
      setPrompt('');
      setCursorIndex(0);
      window.dispatchEvent(
        new CustomEvent('aegis-claude-rewind-open', { detail: { sessionId: activeSession.id } })
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
          createIsolatedWorkspace:
            draftStartMode[activeSession.id] === 'worktree' || undefined,
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
          grokPermissionMode:
            runtimeProvider === 'grok'
              ? agentSelection.kimiPermissionMode
              : undefined,
          grokReasoningEffort:
            runtimeProvider === 'grok'
              ? agentSelection.grokReasoningEffort || undefined
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

    // While a codex turn is streaming, Enter queues the message instead of
    // dispatching it (Codex-Desktop-style): the chip above the composer can
    // steer it into the running turn on demand, otherwise it auto-sends when
    // the turn completes.
    if (canSteerWhileRunning) {
      useComposerQueueStore.getState().enqueue(activeSession.id, {
        id: crypto.randomUUID(),
        displayPrompt: outgoingPrompt,
        effectivePrompt: outgoingEffectivePrompt,
        attachments: outgoingAttachments,
        references: codexReferences,
      });
      resetComposer();
      return;
    }

    sendContinueEvent(activeSession.id, {
      displayPrompt: outgoingPrompt,
      effectivePrompt: outgoingEffectivePrompt,
      attachments: outgoingAttachments,
      references: codexReferences,
    });
    resetComposer();
  };

  // One payload builder for all three continue paths: direct send, chip
  // "Steer" (mid-turn injection), and the queue auto-flush on turn end.
  const sendContinueEvent = (
    sessionId: string,
    outgoing: {
      displayPrompt: string;
      effectivePrompt: string;
      attachments: Attachment[];
      references: CodexReferencePayload;
    }
  ) => {
    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId,
        prompt: outgoing.displayPrompt,
        effectivePrompt: outgoing.effectivePrompt,
        attachments: outgoing.attachments.length > 0 ? outgoing.attachments : undefined,
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
        ...outgoing.references,
        codexPermissionMode:
          runtimeProvider === 'codex'
            ? agentSelection.codexPermissionMode
            : undefined,
        kimiPermissionMode:
          runtimeProvider === 'kimi' || runtimeProvider === 'grok'
            ? agentSelection.kimiPermissionMode
            : undefined,
        grokPermissionMode:
          runtimeProvider === 'grok'
            ? agentSelection.kimiPermissionMode
            : undefined,
        grokReasoningEffort:
          runtimeProvider === 'grok'
            ? agentSelection.grokReasoningEffort || undefined
            : undefined,
        opencodePermissionMode:
          runtimeProvider === 'opencode'
            ? agentSelection.opencodePermissionMode
            : undefined,
        teamMode: 'solo',
        teamId: null,
      },
    });
  };

  // Chip action: inject a queued message into the still-running turn.
  const steerQueuedMessage = (itemId: string) => {
    if (!targetSessionId) return;
    const item = useComposerQueueStore.getState().takeOne(targetSessionId, itemId);
    if (!item) return;
    sendContinueEvent(targetSessionId, item);
  };

  const removeQueuedMessage = (itemId: string) => {
    if (!targetSessionId) return;
    useComposerQueueStore.getState().remove(targetSessionId, itemId);
  };

  // Auto-flush: when the running turn finishes normally, queued messages are
  // sent as the next turn (in queue order, combined into one dispatch). An
  // error outcome keeps them queued so they aren't fired into a broken session.
  // Tracked per session — a pane switch from a running session to a completed
  // one must not read as a "turn just finished" transition.
  const prevStatusRef = useRef<{ sessionId: string | null; status: string | undefined }>({
    sessionId: targetSessionId ?? null,
    status: activeSession?.status,
  });
  useEffect(() => {
    const prev = prevStatusRef.current;
    const current = activeSession?.status;
    prevStatusRef.current = { sessionId: targetSessionId ?? null, status: current };
    if (!targetSessionId || prev.sessionId !== targetSessionId) return;
    if (prev.status !== 'running' || current !== 'completed') return;
    const items = useComposerQueueStore.getState().takeAll(targetSessionId);
    if (items.length === 0) return;
    sendContinueEvent(targetSessionId, {
      displayPrompt: items.map((item) => item.displayPrompt).join('\n\n'),
      effectivePrompt: items.map((item) => item.effectivePrompt).join('\n\n'),
      attachments: items.flatMap((item) => item.attachments),
      references: {
        codexSkills: items.flatMap((item) => item.references.codexSkills ?? []),
        codexMentions: items.flatMap((item) => item.references.codexMentions ?? []),
      },
    });
    // Config for the flushed turn is read from the CURRENT composer selection,
    // matching what a manual send at this moment would use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.status, targetSessionId]);

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

  // ArrowUp on the first visual line ENTERS history browsing; while a browse
  // is active the arrows always step (terminal-style) — recalled multiline
  // prompts leave the caret on their last line and must not require walking
  // it back up before browsing can continue. Editing the recalled text exits
  // the browse and returns the arrows to normal caret movement. Returns true
  // when the key was consumed.
  const handleHistoryArrowKey = (e: ReactKeyboardEvent): boolean => {
    if (
      (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') ||
      e.shiftKey || e.altKey || e.metaKey || e.ctrlKey
    ) {
      return false;
    }

    const caret = editorRef.current?.getCaretInfo();
    if (!caret || !caret.collapsed) {
      // With a non-collapsed selection the arrows keep their native
      // collapse/extend behavior instead of replacing the composer content.
      return false;
    }

    const browsing = historyNavRef.current.index !== null;
    if (!browsing) {
      if (e.key === 'ArrowDown') {
        return false;
      }
      // Entering requires the caret on the first visual row: the editor
      // soft-wraps, so a long logical line spans several rows and the lower
      // ones keep native caret movement. Rect information can be unavailable
      // (e.g. in tests) — fall back to newline scanning.
      const onFirstLine = caret.onFirstVisualLine ?? isCursorOnFirstLine(prompt, caret.index);
      if (!onFirstLine) {
        return false;
      }
    }

    const step = stepPromptHistory(
      promptHistory,
      historyNavRef.current,
      e.key === 'ArrowUp' ? 'prev' : 'next',
      prompt,
      attachments
    );
    if (!step) {
      return false;
    }
    e.preventDefault();
    applyPromptHistoryStep(step);
    return true;
  };

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (isImeComposingEvent(e, isComposingRef)) {
      return;
    }

    // While a history browse is active it owns the arrow keys even when the
    // recalled text re-opened the @-mention or slash menu — a recalled
    // "/rewind" must not trap ArrowUp/ArrowDown in the menu. When idle, the
    // menus keep priority and history only sees keys they did not consume.
    const historyBrowseActive = historyNavRef.current.index !== null;
    if (historyBrowseActive && handleHistoryArrowKey(e)) {
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

    if (!historyBrowseActive && handleHistoryArrowKey(e)) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isRunning) {
        // Steer-capable providers queue mid-turn (handleSend routes to the
        // queue); Enter on an empty composer keeps the old stop shortcut.
        if (canSteerWhileRunning && (prompt.trim() || attachments.length > 0)) {
          handleSend();
        } else {
          handleStop();
        }
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
        {activeSession?.handoffSourceProvider ? (
          <div className="mb-2 flex items-center gap-2 px-1 text-[11.5px] text-[var(--text-muted)]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />
            <span className="min-w-0 truncate">
              Handoff from {providerLabel(activeSession.handoffSourceProvider)}
            </span>
          </div>
        ) : null}
        <Dialog.Root
          open={handoffTarget !== null}
          onOpenChange={(open) => {
            if (!open && !handoffBusy) {
              setHandoffTarget(null);
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/50" />
            <Dialog.Content className="fixed top-1/2 left-1/2 z-[120] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-6 shadow-xl">
              <Dialog.Title className="mb-3 text-lg font-semibold">
                Hand off to {providerLabel(handoffTarget)}?
              </Dialog.Title>
              <Dialog.Description className="mb-5 text-sm leading-relaxed text-[var(--text-secondary)]">
                This conversation is locked to {providerLabel(activeSession?.provider)}. Handing off
                creates a new session for {providerLabel(handoffTarget)} that carries the
                conversation over — your next message will include the context so the new agent can
                continue the work.
              </Dialog.Description>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={handoffBusy}
                  onClick={() => setHandoffTarget(null)}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={handoffBusy}
                  onClick={() => {
                    void confirmHandoff();
                  }}
                  className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {handoffBusy ? 'Handing off…' : 'Hand off'}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {queuedMessages.length > 0 ? (
          <div className="mb-2 flex flex-col gap-1.5 px-1">
            {queuedMessages.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] py-1.5 pl-3 pr-1.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                  {item.displayPrompt || 'Queued message'}
                </span>
                {item.attachments.length > 0 ? (
                  <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                    +{item.attachments.length} file{item.attachments.length > 1 ? 's' : ''}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => steerQueuedMessage(item.id)}
                  disabled={approvalPending}
                  title={
                    canSteerWhileRunning
                      ? 'Send into the running turn now'
                      : 'Send as the next message'
                  }
                  className="flex flex-shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Redo2 className="h-3 w-3" />
                  {canSteerWhileRunning ? 'Steer' : 'Send'}
                </button>
                <button
                  type="button"
                  onClick={() => removeQueuedMessage(item.id)}
                  title="Remove from queue"
                  aria-label="Remove queued message"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
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
                : canSteerWhileRunning
                ? 'Ask for follow-up changes'
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
                onAgentChange={handleAgentChange}
                onModelChange={agentSelection.selectModel}
                codexModels={agentSelection.codexModels.length > 0 ? agentSelection.codexModels : undefined}
                claudeReasoningEffort={agentSelection.claudeReasoningEffort ?? undefined}
                onClaudeReasoningEffortChange={agentSelection.setClaudeReasoningEffort}
                codexReasoningEffort={agentSelection.codexReasoningEffort ?? undefined}
                onCodexReasoningEffortChange={agentSelection.setCodexReasoningEffort}
                grokReasoningEffort={agentSelection.grokReasoningEffort ?? undefined}
                onGrokReasoningEffortChange={agentSelection.setGrokReasoningEffort}
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
              {/* While a steer-capable turn runs, the slot flips with composer
                  content: empty → stop square; typing → the normal send arrow
                  (which queues the follow-up), so the user sees they can send
                  without stopping the agent. */}
              {isRunning &&
              !approvalPending &&
              !(canSteerWhileRunning && (prompt.trim() || attachments.length > 0)) ? (
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
                  modelSetupRequired ||
                  pendingStart ||
                  approvalPending ||
                  (isRunning && !canSteerWhileRunning)
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
