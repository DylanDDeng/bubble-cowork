import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type {
  Attachment,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeCompatibleProviderId,
  CodexExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenCodePermissionMode,
} from '../types';
import coworkLogo from '../assets/cowork-logo.svg';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeAccessModePicker } from './ClaudeAccessModePicker';
import { CodexFastModeToggle } from './CodexFastModeToggle';
import { CodexReasoningEffortPicker } from './CodexReasoningEffortPicker';
import { CodexPermissionModePicker } from './CodexPermissionModePicker';
import { PlanModeBadge, PlanModeMenuItem } from './PlanModeControls';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { SidebarHeaderTrigger } from './Sidebar';
import { SavePromptButton } from './prompts/SavePromptButton';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getLatestProviderModel } from '../utils/session-model';
import {
  buildClaudeModelOptions,
  supportsClaude1mContext,
  loadPreferredClaudeCompatibleProviderId,
  loadPreferredClaudeContext1m,
  loadPreferredClaudeModel,
  savePreferredClaudeCompatibleProviderId,
  savePreferredClaudeContext1m,
  savePreferredClaudeModel,
} from '../utils/claude-model';
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

export function NewSessionView() {
  const {
    pendingStart,
    projectCwd,
    activeChannelByProject,
    sidebarCollapsed,
    sessions,
    agentProfiles,
    setAgentSetupOpen,
    setPendingStart,
    setProjectCwd,
    promptLibraryInsertRequest,
    consumePromptLibraryInsert,
  } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
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
  const [showCwdHint, setShowCwdHint] = useState(false);
  const [claudeAccessMode, setClaudeAccessMode] = useState<ClaudeAccessMode>('default');
  const [claudeExecutionMode, setClaudeExecutionMode] = useState<ClaudeExecutionMode>('execute');
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
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const cwd = projectCwd || '';
  const hasSelectedCwd = cwd.trim().length > 0;
  const agentProfileCount = Object.keys(agentProfiles).length;
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
  const recentClaudeModel = useMemo(
    () => getLatestProviderModel(sessions, 'claude'),
    [sessions]
  );
  const pickerClaudeRuntimeModel = useMemo(
    () => (recentClaudeModel && availableClaudeModels.includes(recentClaudeModel) ? recentClaudeModel : null),
    [availableClaudeModels, recentClaudeModel]
  );
  const recentCodexModel = useMemo(
    () => getLatestProviderModel(sessions, 'codex'),
    [sessions]
  );
  const recentOpencodeModel = useMemo(
    () => getLatestProviderModel(sessions, 'opencode'),
    [sessions]
  );
  const recentProjectOptions = useMemo(() => {
    if (!cwd) {
      return recentCwds.slice(0, 6);
    }

    const next = [cwd, ...recentCwds.filter((dir) => dir !== cwd)];
    return next.slice(0, 6);
  }, [cwd, recentCwds]);
  const skillAutocomplete = useComposerCapabilityMenu({
    enabled: true,
    enableSkills: true,
    provider,
    prompt,
    cursorIndex,
    projectPath: cwd || undefined,
    setPrompt,
    setCursorIndex,
  });
  const projectFileMentions = useProjectFileMentions({
    cwd,
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

  // 加载最近工作目录
  useEffect(() => {
    window.electron.getRecentCwds(8).then(setRecentCwds);
  }, []);

  useEffect(() => {
    if (provider === 'codex' || provider === 'aegis') {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath: cwd || undefined },
    });
  }, [cwd, provider]);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = window.setTimeout(() => setShowCwdHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showCwdHint]);

  const buildDispatchPrompt = async (): Promise<string | null> => {
    const trimmedPrompt = prompt.trim();

    const selectedSkill = skillAutocomplete.selectedSkill;
    if (selectedSkill) {
      const selectedSkillRemainder = skillAutocomplete.selectedSkillRemainder;
      const expandedPrompt =
        provider === 'codex'
          ? selectedSkillRemainder.trim()
          : provider === 'claude'
            ? trimmedPrompt
            : provider === 'opencode'
              ? await (async () => {
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
              })()
              : trimmedPrompt;

      if (expandedPrompt === null) {
        return null;
      }

      return buildPromptWithProjectFileMentions({
        cwd,
        prompt: expandedPrompt,
      });
    }

    return buildPromptWithProjectFileMentions({
      cwd,
      prompt: trimmedPrompt,
    });
  };

  useEffect(() => {
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
  }, [availableClaudeModels, claudeModelConfig.defaultModel, selectedClaudeModel]);

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
    if (supportsClaude1mContext(selectedClaudeModel)) {
      return;
    }
    if (selectedClaudeContext1m) {
      setSelectedClaudeContext1m(false);
      savePreferredClaudeContext1m(false);
    }
  }, [selectedClaudeContext1m, selectedClaudeModel]);

  useEffect(() => {
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
  }, [codexModelOptions, selectedCodexModel]);

  useEffect(() => {
    if (!resolvedSelectedCodexModel) {
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
  }, [codexModelConfig, resolvedSelectedCodexModel, selectedCodexFastMode, selectedCodexReasoningEffort]);

  useEffect(() => {
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
  }, [opencodeModelOptions, selectedOpencodeModel]);

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
      cwd,
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
  }, [attachments, cwd, skillAutocomplete]);

  const handleStart = async () => {
    if (!prompt.trim() && attachments.length === 0) return;
    if (!hasSelectedCwd) {
      toast.error('Select a project folder before starting a task.');
      setShowCwdHint(true);
      return;
    }

    setPendingStart(true);
    setMenuOpen(false);

    const displayPrompt = prompt.trim();
    const normalizedPrompt = await buildDispatchPrompt();
    if (normalizedPrompt === null) {
      setPendingStart(false);
      return;
    }
    const promptWithAttachment = await maybeConvertLongPromptToAttachment({
      cwd,
      prompt: displayPrompt,
      attachments,
    });
    const outgoingPrompt = promptWithAttachment.converted ? promptWithAttachment.prompt : displayPrompt;
    const outgoingEffectivePrompt = promptWithAttachment.converted
      ? promptWithAttachment.prompt
      : normalizedPrompt;
    const outgoingAttachments = promptWithAttachment.attachments;
    const codexReferences =
      provider === 'codex'
        ? buildCodexReferencePayload(skillAutocomplete.selectedSkill)
        : {};
    if (promptWithAttachment.reason === 'attachment_create_failed') {
      toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
    }

    // 用 prompt 前 30 字符作为临时标题（后台会异步生成更好的标题）
    const tempTitleSource = displayPrompt || outgoingPrompt;
    const tempTitle = tempTitleSource.slice(0, 30) + (tempTitleSource.length > 30 ? '...' : '');
    const projectKey = (cwd || '').trim() || '__no_project__';
    const channelId = activeChannelByProject[projectKey] || DEFAULT_WORKSPACE_CHANNEL_ID;

    // 立即发送开始会话事件
    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: outgoingPrompt,
        effectivePrompt: outgoingEffectivePrompt,
        cwd: cwd || undefined,
        channelId,
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
        claudeAccessMode: provider === 'claude' ? claudeAccessMode : undefined,
        claudeExecutionMode: provider === 'claude' ? claudeExecutionMode : undefined,
        codexExecutionMode: provider === 'codex' ? selectedCodexExecutionMode : undefined,
        codexPermissionMode: provider === 'codex' ? selectedCodexPermissionMode : undefined,
        codexReasoningEffort:
          provider === 'codex' ? selectedCodexReasoningEffort : undefined,
        codexFastMode:
          provider === 'codex' ? selectedCodexFastMode : undefined,
        codexSkills: provider === 'codex' ? codexReferences.codexSkills : undefined,
        codexMentions: provider === 'codex' ? codexReferences.codexMentions : undefined,
        opencodePermissionMode:
          provider === 'opencode' ? selectedOpencodePermissionMode : undefined,
        aegisPermissionMode:
          provider === 'aegis' ? 'defaultPermissions' : undefined,
      },
    });

    // 清空输入
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
    [cwd, projectFileMentions.mention, skillAutocomplete]
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

    void (async () => {
      const promptWithAttachment = await maybeConvertLongPromptToAttachment({
        cwd,
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
  }, [attachments, cwd, skillAutocomplete]);

  const handleProviderChange = (next: typeof provider) => {
    setProvider(next);
    savePreferredProvider(next);
  };

  const canStartTask =
    (prompt.trim().length > 0 || attachments.length > 0) &&
    !pendingStart &&
    hasSelectedCwd;

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

    if (e.key === 'Enter' && !e.shiftKey && (prompt.trim() || attachments.length > 0) && !pendingStart) {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* 顶部拖拽区域 */}
      <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0`}>
        <div className="flex h-full items-center px-3">
          {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 flex justify-center px-8 pb-4 pt-10">
        <div className="flex h-full w-full max-w-[920px] flex-col">
          <div className="flex flex-1 items-center justify-center text-center">
            <div>
              <div className="mb-8 flex justify-center no-drag">
                <img
                  src={coworkLogo}
                  alt=""
                  className="h-16 w-16 select-none opacity-90 no-drag"
                  aria-hidden="true"
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                />
              </div>

              <h1 className="text-[20px] font-bold serif-display leading-tight text-[var(--text-primary)]">
                What can I help you with?
              </h1>

              {!hasSelectedCwd ? (
                <div className="mt-5 text-[13px] text-[var(--text-secondary)]">
                  Select a project folder to enable starting a new task.
                </div>
              ) : (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3 text-[12px] text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-1">
                    <kbd className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)] border border-[var(--border)]">/</kbd>
                    Commands
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-1">
                    <kbd className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)] border border-[var(--border)]">@</kbd>
                    Mention files
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-1">
                    <kbd className="rounded bg-[var(--bg-primary)] px-1 py-0.5 text-[10px] font-semibold text-[var(--text-secondary)] border border-[var(--border)]">Shift+Enter</kbd>
                    New line
                  </span>
                </div>
              )}

              {agentProfileCount === 0 ? (
                <div className="mt-5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setAgentSetupOpen(true)}
                    className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--bg-tertiary)]"
                  >
                    Set up agents
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-auto">
            <div
              className={`flex justify-center overflow-hidden transition-all duration-200 ${
                showCwdHint
                  ? 'mb-3 max-h-16 opacity-100 translate-y-0'
                  : 'mb-0 max-h-0 opacity-0 -translate-y-1 pointer-events-none'
              }`}
            >
              <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-sm">
                Select a project folder before starting a new task.
              </div>
            </div>

            {/* Composer */}
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
                    title={skillAutocomplete.menuTitle}
                    emptyMessage={skillAutocomplete.emptyMessage}
                    onSelect={skillAutocomplete.selectSuggestion}
                    onHighlight={skillAutocomplete.setSelectedIndex}
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
                placeholder="Describe your task..."
                className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none no-drag min-h-[56px] max-h-[200px]"
                autoFocus
              />

              {/* 底部工具栏 */}
              <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
              <AgentModelPicker
                provider={provider}
                onProviderChange={handleProviderChange}
                disabled={pendingStart}
              claudeModel={{
                value: selectedClaudeModel,
                compatibleProviderId: selectedClaudeCompatibleProviderId,
                config: claudeModelConfig,
                runtimeModel: pickerClaudeRuntimeModel,
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
                runtimeModel: recentCodexModel,
                onChange: (model) => {
                  setSelectedCodexModel(model);
                  savePreferredCodexModel(model);
                },
              }}
              opencodeModel={{
                value: selectedOpencodeModel,
                options: opencodeModelOptions,
                runtimeModel: recentOpencodeModel,
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
                    disabled={pendingStart}
                  />
                  {codexFastModeSupported && (
                    <CodexFastModeToggle
                      enabled={selectedCodexFastMode}
                      onToggle={(enabled) => {
                        setSelectedCodexFastMode(enabled);
                        savePreferredCodexFastMode(codexModelConfig, selectedCodexModel, enabled);
                      }}
                      disabled={pendingStart}
                    />
                  )}
                </div>
              )}

              {provider === 'claude' && claudeExecutionMode === 'plan' ? (
                <PlanModeBadge
                  onDisable={() => setClaudeExecutionMode('execute')}
                  disabled={pendingStart}
                />
              ) : null}

              {provider === 'codex' && selectedCodexExecutionMode === 'plan' ? (
                <PlanModeBadge
                  onDisable={() => {
                    setSelectedCodexExecutionMode('execute');
                    savePreferredCodexExecutionMode('execute');
                  }}
                  disabled={pendingStart}
                />
              ) : null}

              <SavePromptButton content={promptLibraryContent} disabled={pendingStart} />

              <div className="relative no-drag">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={pendingStart}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] transition-all duration-150 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Add"
                  aria-label="Add"
                >
                  <PlusIcon />
                </button>

                {menuOpen && !pendingStart && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="popover-surface absolute bottom-full mb-2 left-0 z-30 p-1.5 min-w-[220px]">
                      <button
                        onClick={async () => {
                          setMenuOpen(false);
                          await handleAddAttachments();
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-[var(--text-primary)]"
                      >
                        <PaperclipIcon />
                        <span>Add files or photos</span>
                      </button>
                      {provider === 'claude' || provider === 'codex' ? (
                        <>
                          <div className="my-1 h-px bg-[var(--border)]/70" />
                          <PlanModeMenuItem
                            providerLabel={provider === 'codex' ? 'Codex' : 'Claude'}
                            active={
                              provider === 'codex'
                                ? selectedCodexExecutionMode === 'plan'
                                : claudeExecutionMode === 'plan'
                            }
                            onChange={(active) => {
                              if (provider === 'codex') {
                                const nextMode = active ? 'plan' : 'execute';
                                setSelectedCodexExecutionMode(nextMode);
                                savePreferredCodexExecutionMode(nextMode);
                              } else {
                                setClaudeExecutionMode(active ? 'plan' : 'execute');
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
              <button
                onClick={handleStart}
                disabled={!canStartTask}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] transition-all duration-150 hover:scale-105 no-drag disabled:cursor-not-allowed disabled:opacity-20 disabled:hover:scale-100"
              >
                {pendingStart ? (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ArrowUpIcon />
                )}
              </button>
              </div>
              </div>
              </div>
              </div>
              {(provider === 'claude' || provider === 'codex' || provider === 'opencode') && (
                <div className="flex items-center justify-start px-4 pt-2 text-[12px]">
                  {provider === 'claude' ? (
                    <div className="flex items-center gap-4">
                      <ClaudeAccessModePicker
                        value={claudeAccessMode}
                        onChange={setClaudeAccessMode}
                        disabled={pendingStart}
                      />
                    </div>
                  ) : provider === 'codex' ? (
                    <div className="flex items-center gap-4">
                      <CodexPermissionModePicker
                        value={selectedCodexPermissionMode}
                        onChange={(mode) => {
                          setSelectedCodexPermissionMode(mode);
                          savePreferredCodexPermissionMode(mode);
                        }}
                        disabled={pendingStart}
                      />
                    </div>
                  ) : (
                    <CodexPermissionModePicker
                      value={selectedOpencodePermissionMode}
                      onChange={(mode) => {
                        setSelectedOpencodePermissionMode(mode);
                        savePreferredOpencodePermissionMode(mode);
                      }}
                      disabled={pendingStart}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
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

function PaperclipIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.19 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49"
      />
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
