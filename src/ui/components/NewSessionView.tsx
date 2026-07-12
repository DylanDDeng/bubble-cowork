import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { SidebarHeaderTrigger } from './Sidebar';
import { ComposerAgentModelPicker } from './ComposerAgentControls';
import { ClaudePermissionModePicker } from './ClaudePermissionModePicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { KimiPermissionModePicker } from './KimiPermissionModePicker';
import { OpenCodePermissionModePicker } from './OpenCodePermissionModePicker';
import { FolderOpen } from './icons';
import { NewThreadLanding } from './NewThreadLanding';
import { ComposerContextPills } from './ComposerContextPills';
import { useComposerAgentSelection } from '../hooks/useComposerAgentSelection';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { useProjectStarterPrompts } from '../hooks/useProjectStarterPrompts';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { buildCodexReferencePayload } from '../utils/codex-composer';
import { insertProjectFileMention } from '../utils/project-file-mentions';
import { buildPromptWithProjectFileMentions } from '../utils/project-file-mention-context';
import {
  getLongPromptAttachmentFallbackMessage,
  LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD,
  maybeConvertLongPromptToAttachment,
} from '../utils/long-prompt-attachment';

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

export function NewSessionView() {
  const {
    pendingStart,
    projectCwd,
    activeChannelByProject,
    sidebarCollapsed,
    setPendingStart,
    setProjectCwd,
    setActiveChannelForProject,
    setShowSettings,
    setActiveSettingsTab,
    promptLibraryInsertRequest,
    consumePromptLibraryInsert,
  } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 启动模式 pill：worktree = 提交时先建隔离 worktree
  const [startMode, setStartMode] = useState<'local' | 'worktree'>('local');
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [showCwdHint, setShowCwdHint] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const cwd = projectCwd || '';
  const hasSelectedCwd = cwd.trim().length > 0;
  const starterPrompts = useProjectStarterPrompts(cwd);
  const agentSelection = useComposerAgentSelection({ selectionKey: '__new_session__' });
  const modelSetupRequired = Boolean(agentSelection.modelSetup);
  const capabilityMenu = useComposerCapabilityMenu({
    enabled: true,
    enableSkills: true,
    provider: agentSelection.provider,
    prompt,
    cursorIndex,
    projectPath: cwd || undefined,
    setPrompt,
    setCursorIndex,
  });
  const recentProjectOptions = useMemo(() => {
    if (!cwd) {
      return recentCwds.slice(0, 6);
    }

    const next = [cwd, ...recentCwds.filter((dir) => dir !== cwd)];
    return next.slice(0, 6);
  }, [cwd, recentCwds]);

  const projectFileMentions = useProjectFileMentions({
    cwd,
    prompt,
    cursorIndex,
  });

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
    window.electron.getRecentCwds(8).then(setRecentCwds);
  }, []);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = window.setTimeout(() => setShowCwdHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showCwdHint]);

  const buildDispatchPrompt = async (dispatchCwd = cwd): Promise<string | null> => {
    const selectedSkillPrompt =
      capabilityMenu.selectedSkill && agentSelection.provider === 'codex'
        ? capabilityMenu.selectedSkillRemainder.trim()
        : prompt.trim();

    return buildPromptWithProjectFileMentions({
      cwd: dispatchCwd,
      prompt: selectedSkillPrompt,
      ignoredMentionPaths: [],
    });
  };

  const handleSelectProjectFolder = useCallback(async (): Promise<string | null> => {
    if (pendingStart) {
      return null;
    }

    const selected = await window.electron.selectDirectory();
    if (!selected) {
      return null;
    }

    setProjectCwd(selected);
    setActiveChannelForProject(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
    setShowCwdHint(false);
    window.requestAnimationFrame(() => editorRef.current?.focus());
    return selected;
  }, [pendingStart, setActiveChannelForProject, setProjectCwd]);

  const openModelSetup = useCallback(() => {
    const setup = agentSelection.modelSetup;
    if (!setup) {
      return;
    }
    setActiveSettingsTab(setup.settingsTab);
    setShowSettings(true);
  }, [agentSelection.modelSetup, setActiveSettingsTab, setShowSettings]);

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
      cwd,
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
  }, [attachments, cwd]);

  const handleStart = async () => {
    if (!prompt.trim() && attachments.length === 0) return;
    if (agentSelection.modelSetup) {
      toast.error(agentSelection.modelSetup.title);
      openModelSetup();
      return;
    }
    let dispatchCwd = cwd.trim();
    if (!dispatchCwd) {
      setShowCwdHint(true);
      const selected = await handleSelectProjectFolder();
      if (!selected) {
        return;
      }
      dispatchCwd = selected;
    }

    setPendingStart(true);

    const displayPrompt = prompt.trim();
    const normalizedPrompt = await buildDispatchPrompt(dispatchCwd);
    if (normalizedPrompt === null) {
      setPendingStart(false);
      return;
    }
    const promptWithAttachment = await maybeConvertLongPromptToAttachment({
      cwd: dispatchCwd,
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
      agentSelection.provider === 'codex'
        ? buildCodexReferencePayload(capabilityMenu.selectedSkill)
        : {};
    const tempTitleSource = displayPrompt || outgoingPrompt;
    const tempTitle = tempTitleSource.slice(0, 30) + (tempTitleSource.length > 30 ? '...' : '');
    const channelId = activeChannelByProject[dispatchCwd] || DEFAULT_WORKSPACE_CHANNEL_ID;

    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: outgoingPrompt,
        effectivePrompt: outgoingEffectivePrompt,
        cwd: dispatchCwd || undefined,
        channelId,
        createIsolatedWorkspace: startMode === 'worktree' || undefined,
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
        provider: agentSelection.provider,
        model: agentSelection.model || undefined,
        compatibleProviderId:
          agentSelection.provider === 'claude'
            ? agentSelection.compatibleProviderId || undefined
            : undefined,
        claudeAccessMode:
          agentSelection.provider === 'claude'
            ? agentSelection.claudePermissionMode
            : undefined,
        claudeExecutionMode:
          agentSelection.provider === 'claude' && agentSelection.claudePermissionMode === 'plan'
            ? 'plan'
            : agentSelection.provider === 'claude'
              ? 'execute'
              : undefined,
        claudeReasoningEffort:
          agentSelection.provider === 'claude'
            ? agentSelection.claudeReasoningEffort || undefined
            : undefined,
        ...codexReferences,
        codexPermissionMode:
          agentSelection.provider === 'codex'
            ? agentSelection.codexPermissionMode
            : undefined,
        kimiPermissionMode:
          agentSelection.provider === 'kimi' || agentSelection.provider === 'grok'
            ? agentSelection.kimiPermissionMode
            : undefined,
        grokPermissionMode:
          agentSelection.provider === 'grok'
            ? agentSelection.kimiPermissionMode
            : undefined,
        grokReasoningEffort:
          agentSelection.provider === 'grok'
            ? agentSelection.grokReasoningEffort || undefined
            : undefined,
        opencodePermissionMode:
          agentSelection.provider === 'opencode'
            ? agentSelection.opencodePermissionMode
            : undefined,
        teamMode: 'solo',
        teamId: null,
      },
    });

    setPrompt('');
    setAttachments([]);
  };

  const handleCwdChange = (next: string) => {
    setProjectCwd(next || null);
  };

  const handleAddAttachments = async () => {
    if (pendingStart) return;
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
    [cwd, projectFileMentions.mention, prompt]
  );

  const handlePromptChange = async (value: string, nextCursorIndex: number) => {
    await autoConvertComposerTextToAttachment(value, nextCursorIndex);
  };

  const handlePasteImages = useCallback(async (
    images: { mimeType: string; data: Uint8Array; name?: string }[]
  ): Promise<boolean> => {
    if (pendingStart || images.length === 0) return false;

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
  }, [pendingStart]);

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
          cwd,
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
  }, [attachments, cwd, prompt]);

  const canStartTask =
    (prompt.trim().length > 0 || attachments.length > 0) &&
    !pendingStart &&
    !modelSetupRequired;

  const projectName = cwd ? cwd.split('/').filter(Boolean).pop() || cwd : '';
  const heading = hasSelectedCwd
    ? `What should we build in ${projectName}?`
    : 'What can I help you with?';

  const handleUseStarter = (text: string) => {
    setPrompt(text);
    setCursorIndex(text.length);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setCursorIndex(text.length);
    });
  };

  const handleConnectApps = () => {
    setActiveSettingsTab('mcp');
    setShowSettings(true);
  };

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

    if (e.key === 'Enter' && !e.shiftKey && canStartTask) {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0`}>
        <div className="flex h-full items-center px-3">
          {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
        </div>
      </div>

      <NewThreadLanding
        heading={heading}
        prompts={starterPrompts}
        onPickSuggestion={handleUseStarter}
        onConnectApps={handleConnectApps}
      >
            <div className="group relative rounded-[18px] bg-[var(--bg-secondary)] shadow-[0_2px_8px_rgba(15,23,42,0.04)]">
              {projectFileMentions.hasMentionQuery ? (
                <div className="absolute inset-x-0 bottom-full z-40 mb-1">
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
                <div className="absolute inset-x-0 bottom-full z-40 mb-1">
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

              <div className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_4px_16px_rgba(15,23,42,0.08)]">
                {attachments.length > 0 && (
                  <div className="px-4 pt-4">
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
                  placeholder="Message the agent..."
                  className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none no-drag min-h-[56px] max-h-[200px]"
                  autoFocus
                />

                {/* Control order mirrors PromptInput (model → permission → attach)
                    so the first-run composer matches every later composer. */}
                <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
                  <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
                    <ComposerAgentModelPicker
                      agentProvider={agentSelection.provider}
                      modelLabel={agentSelection.selectedModelLabel}
                      modelValue={agentSelection.model}
                      allAgentModelOptions={agentSelection.allAgentModelOptions}
                      disabled={pendingStart}
                      onAgentChange={agentSelection.selectAgent}
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
                      menuSide="bottom"
                    />
                    {agentSelection.provider === 'codex' && (
                      <CodexPermissionModePicker
                        value={agentSelection.codexPermissionMode}
                        onChange={agentSelection.setCodexPermissionMode}
                        menuSide="bottom"
                      />
                    )}
                    {agentSelection.provider === 'claude' && (
                      <ClaudePermissionModePicker
                        value={agentSelection.claudePermissionMode}
                        onChange={agentSelection.setClaudePermissionMode}
                        disabled={pendingStart}
                        menuSide="bottom"
                      />
                    )}
                    {agentSelection.provider === 'opencode' && (
                      <OpenCodePermissionModePicker
                        value={agentSelection.opencodePermissionMode}
                        onChange={agentSelection.setOpencodePermissionMode}
                        disabled={pendingStart}
                        menuSide="bottom"
                      />
                    )}
                    {(agentSelection.provider === 'kimi' || agentSelection.provider === 'grok') && (
                      <KimiPermissionModePicker
                        value={agentSelection.kimiPermissionMode}
                        onChange={agentSelection.setKimiPermissionMode}
                        menuSide="bottom"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        void handleAddAttachments();
                      }}
                      disabled={pendingStart}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                      title="Add files or photos"
                      aria-label="Add files or photos"
                    >
                      <PlusIcon />
                    </button>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={handleStart}
                      disabled={!canStartTask}
                      className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105 no-drag disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100"
                    >
                      {pendingStart ? (
                        <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : !hasSelectedCwd ? (
                        <FolderOpen className="h-[18px] w-[18px]" />
                      ) : (
                        <ArrowUpIcon />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <ComposerContextPills
                cwd={cwd || null}
                projectName={projectName}
                hasSelectedCwd={hasSelectedCwd}
                disabled={pendingStart}
                onBrowse={() => {
                  void handleSelectProjectFolder();
                }}
                recentOptions={recentProjectOptions}
                onSelectRecent={handleCwdChange}
                startMode={startMode}
                onStartModeChange={setStartMode}
              />
            </div>
      </NewThreadLanding>
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

function PlusIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}
