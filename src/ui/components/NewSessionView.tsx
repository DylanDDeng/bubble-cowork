import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { AgentProfile, Attachment } from '../types';
import coworkLogo from '../assets/cowork-logo.svg';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { ProjectFileMentionMenu } from './ProjectFileMentionMenu';
import { ProjectAgentMentionMenu } from './ProjectAgentMentionMenu';
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from './ComposerPromptEditor';
import { SidebarHeaderTrigger } from './Sidebar';
import { SavePromptButton } from './prompts/SavePromptButton';
import { ProjectAgentPicker } from './ProjectAgentPicker';
import { FolderOpen } from './icons';
import { useComposerCapabilityMenu } from '../hooks/useClaudeSkillAutocomplete';
import { useProjectFileMentions } from '../hooks/useProjectFileMentions';
import { useProjectAgentMentions } from '../hooks/useProjectAgentMentions';
import {
  DEFAULT_WORKSPACE_CHANNEL_ID,
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

export function NewSessionView() {
  const {
    pendingStart,
    projectCwd,
    activeChannelByProject,
    sidebarCollapsed,
    agentProfiles,
    projectAgentRostersByProject,
    selectedProjectAgentByProject,
    setAgentSetupOpen,
    setPendingStart,
    setProjectCwd,
    setActiveChannelForProject,
    setProjectAgentRoster,
    setSelectedProjectAgentForProject,
    promptLibraryInsertRequest,
    consumePromptLibraryInsert,
  } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showCwdHint, setShowCwdHint] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const isComposingRef = useRef(false);
  const cwd = projectCwd || '';
  const hasSelectedCwd = cwd.trim().length > 0;
  const enabledAgentProfiles = useMemo(
    () => Object.values(agentProfiles)
      .filter((profile) => profile.enabled)
      .sort((left, right) => left.createdAt - right.createdAt),
    [agentProfiles]
  );
  const projectAgentProfiles = useMemo(
    () =>
      getProjectAgentProfiles({
        agentProfiles,
        projectAgentRostersByProject,
        cwd,
      }),
    [agentProfiles, cwd, projectAgentRostersByProject]
  );
  const newSessionAgentProfiles =
    projectAgentProfiles.length > 0 ? projectAgentProfiles : enabledAgentProfiles;
  const projectAgentMentionHandles = useMemo(
    () => getAgentMentionHandles(newSessionAgentProfiles),
    [newSessionAgentProfiles]
  );
  const projectAgentMentionLabels = useMemo(
    () =>
      Object.fromEntries(
        newSessionAgentProfiles.flatMap((profile) =>
          getAgentMentionAliases(profile).map((handle) => [
            handle,
            profile.name.trim() || 'Agent',
          ])
        )
      ),
    [newSessionAgentProfiles]
  );
  const selectedProjectAgentProfile = useMemo(() => {
    const persistedProfileId = cwd ? selectedProjectAgentByProject[cwd] : null;
    return (
      newSessionAgentProfiles.find((profile) => profile.id === selectedAgentId) ||
      newSessionAgentProfiles.find((profile) => profile.id === persistedProfileId) ||
      newSessionAgentProfiles[0] ||
      null
    );
  }, [cwd, newSessionAgentProfiles, selectedAgentId, selectedProjectAgentByProject]);
  const projectAgentRoutes = useMemo(
    () => resolveProjectAgentMentionRoutes(prompt, newSessionAgentProfiles),
    [newSessionAgentProfiles, prompt]
  );
  const activeProjectAgentRoutes = useMemo(
    () =>
      projectAgentRoutes.map((route) => ({
        profile: route.profile,
        handle: route.handle,
        assignmentSource: 'mention' as const,
      })),
    [projectAgentRoutes]
  );
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
  const runtimeAgentProfile = effectiveProjectAgentRoutes[0]?.profile || null;
  const agentRuntime = getAgentRuntime(runtimeAgentProfile);
  const runtimeProvider = agentRuntime?.provider || 'claude';
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
    provider: runtimeProvider,
    prompt,
    cursorIndex,
    projectPath: cwd || undefined,
    setPrompt,
    setCursorIndex,
  });
  const projectAgentMentions = useProjectAgentMentions({
    profiles: newSessionAgentProfiles,
    prompt: skillAutocomplete.displayPrompt,
    cursorIndex,
  });
  const projectFileMentions = useProjectFileMentions({
    cwd,
    prompt: skillAutocomplete.displayPrompt,
    cursorIndex,
  });
  const projectAgentMentionActive =
    projectAgentMentions.hasMentionQuery && projectAgentMentions.suggestions.length > 0;
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
    if (
      selectedAgentId &&
      newSessionAgentProfiles.some((profile) => profile.id === selectedAgentId)
    ) {
      return;
    }

    const persistedProfileId = cwd ? selectedProjectAgentByProject[cwd] : null;
    const nextProfile =
      newSessionAgentProfiles.find((profile) => profile.id === persistedProfileId) ||
      newSessionAgentProfiles[0] ||
      null;
    setSelectedAgentId(nextProfile?.id || null);
  }, [cwd, newSessionAgentProfiles, selectedAgentId, selectedProjectAgentByProject]);

  useEffect(() => {
    if (runtimeProvider === 'codex' || runtimeProvider === 'aegis') {
      return;
    }

    sendEvent({
      type: 'skills.list',
      payload: { projectPath: cwd || undefined },
    });
  }, [cwd, runtimeProvider]);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = window.setTimeout(() => setShowCwdHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showCwdHint]);

  const buildDispatchPrompt = async (dispatchCwd = cwd): Promise<string | null> => {
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
        cwd: dispatchCwd,
        prompt: expandedPrompt,
        ignoredMentionPaths: projectAgentMentionHandles,
      });
    }

    return buildPromptWithProjectFileMentions({
      cwd: dispatchCwd,
      prompt: trimmedPrompt,
      ignoredMentionPaths: projectAgentMentionHandles,
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
    let dispatchCwd = cwd.trim();
    if (!dispatchCwd) {
      setShowCwdHint(true);
      const selected = await handleSelectProjectFolder();
      if (!selected) {
        return;
      }
      dispatchCwd = selected;
    }
    if (!runtimeAgentProfile || !agentRuntime) {
      toast.error(
        enabledAgentProfiles.length === 0
          ? 'Set up an agent before starting a task.'
          : 'Select an agent before starting a task.'
      );
      return;
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
    const rawOutgoingEffectivePrompt = promptWithAttachment.converted
      ? promptWithAttachment.prompt
      : normalizedPrompt;
    const outgoingAttachments = promptWithAttachment.attachments;
    const codexReferences =
      runtimeProvider === 'codex'
        ? buildCodexReferencePayload(skillAutocomplete.selectedSkill)
        : {};
    const aegisReferences =
      runtimeProvider === 'aegis'
        ? buildAegisReferencePayload(skillAutocomplete.selectedSkill)
        : {};
    const activeAgentRuntimePayload = buildAgentRuntimePayload(runtimeAgentProfile, codexReferences, aegisReferences);
    if (!activeAgentRuntimePayload) {
      toast.error('Selected agent is not available.');
      setPendingStart(false);
      return;
    }
    const outgoingEffectivePrompt = buildAgentEffectivePrompt(
      rawOutgoingEffectivePrompt,
      runtimeAgentProfile,
      {
        mode: 'project',
        cwd: dispatchCwd,
        channelId: activeChannelByProject[dispatchCwd] || DEFAULT_WORKSPACE_CHANNEL_ID,
        handle: effectiveProjectAgentRoutes[0]?.handle,
        assignmentSource: effectiveProjectAgentRoutes[0]?.assignmentSource,
      },
      { includeIdentity: runtimeProvider !== 'aegis' }
    );
    const projectAgentRuntimePayloads = newSessionAgentProfiles
      .map((profile) => buildAgentRuntimePayload(profile, codexReferences, aegisReferences))
      .filter((turn): turn is RoutedAgentRuntimePayload => Boolean(turn));
    const projectPublicAgents = newSessionAgentProfiles.map(toPublicAgentProfile);
    const projectRoutedAgentTurns: RoutedAgentTurnPayload[] = effectiveProjectAgentRoutes
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
            cwd: dispatchCwd,
            channelId: activeChannelByProject[dispatchCwd] || DEFAULT_WORKSPACE_CHANNEL_ID,
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
      .filter((turn): turn is RoutedAgentTurnPayload => Boolean(turn));
    if (promptWithAttachment.reason === 'attachment_create_failed') {
      toast.error('Failed to convert the long message into an attachment. Sending inline instead.');
    }

    // 用 prompt 前 30 字符作为临时标题（后台会异步生成更好的标题）
    const tempTitleSource = displayPrompt || outgoingPrompt;
    const tempTitle = tempTitleSource.slice(0, 30) + (tempTitleSource.length > 30 ? '...' : '');
    const projectKey = dispatchCwd;
    const channelId = activeChannelByProject[projectKey] || DEFAULT_WORKSPACE_CHANNEL_ID;
    const currentRoster = projectAgentRostersByProject[projectKey] || [];
    if (!currentRoster.includes(runtimeAgentProfile.id)) {
      setProjectAgentRoster(projectKey, [...currentRoster, runtimeAgentProfile.id]);
    }
    setSelectedProjectAgentForProject(projectKey, runtimeAgentProfile.id);

    // 立即发送开始会话事件
    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: outgoingPrompt,
        effectivePrompt: outgoingEffectivePrompt,
        cwd: dispatchCwd || undefined,
        channelId,
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
        provider: runtimeProvider,
        model:
          runtimeProvider === 'claude'
            ? agentRuntime.model || undefined
            : runtimeProvider === 'codex'
              ? agentRuntime.model || undefined
              : runtimeProvider === 'opencode'
                ? agentRuntime.model || undefined
                : runtimeProvider === 'aegis'
                  ? agentRuntime.model || undefined
                : undefined,
        compatibleProviderId:
          runtimeProvider === 'claude' ? agentRuntime.compatibleProviderId : undefined,
        claudeAccessMode: runtimeProvider === 'claude' ? agentRuntime.claudeAccessMode : undefined,
        claudeExecutionMode: runtimeProvider === 'claude' ? agentRuntime.claudeExecutionMode : undefined,
        claudeReasoningEffort: runtimeProvider === 'claude' ? agentRuntime.claudeReasoningEffort : undefined,
        codexExecutionMode: runtimeProvider === 'codex' ? agentRuntime.codexExecutionMode : undefined,
        codexPermissionMode: runtimeProvider === 'codex' ? agentRuntime.codexPermissionMode : undefined,
        codexReasoningEffort:
          runtimeProvider === 'codex' ? agentRuntime.codexReasoningEffort : undefined,
        codexSkills: runtimeProvider === 'codex' ? codexReferences.codexSkills : undefined,
        codexMentions: runtimeProvider === 'codex' ? codexReferences.codexMentions : undefined,
        aegisSkills: runtimeProvider === 'aegis' ? aegisReferences.aegisSkills : undefined,
        aegisMentions: runtimeProvider === 'aegis' ? aegisReferences.aegisMentions : undefined,
        opencodePermissionMode:
          runtimeProvider === 'opencode' ? agentRuntime.opencodePermissionMode : undefined,
        aegisPermissionMode:
          runtimeProvider === 'aegis' ? agentRuntime.aegisPermissionMode : undefined,
        aegisReasoningEffort:
          runtimeProvider === 'aegis' ? agentRuntime.aegisReasoningEffort : undefined,
        routedAgentId: runtimeAgentProfile.id,
        routedAgentProfile: runtimeProvider === 'aegis' ? activeAgentRuntimePayload : undefined,
        routedAgentTurns: projectRoutedAgentTurns,
        availableAgentTurns: projectAgentRuntimePayloads,
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

  const canStartTask =
    (prompt.trim().length > 0 || attachments.length > 0) &&
    !pendingStart &&
    Boolean(runtimeAgentProfile);

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
                  Draft the task here, then choose a project folder to run it.
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

              {enabledAgentProfiles.length === 0 ? (
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
              <div className="flex items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] shadow-sm">
                <span>Choose a project folder to start this task.</span>
                <button
                  type="button"
                  onClick={() => {
                    void handleSelectProjectFolder();
                  }}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[var(--text-primary)] px-2.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-85"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Choose
                </button>
              </div>
            </div>

            {/* Composer */}
            <div className="mx-auto max-w-4xl">
              <div className="group relative rounded-[28px] bg-[var(--border)]/45 p-px transition-colors duration-200 focus-within:bg-[var(--border)]/70">
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
                  hasSelectedCwd
                    ? 'Describe your task...'
                    : 'Describe your task. Choose a project folder before it runs...'
                }
                className="w-full bg-transparent px-4 pt-3 pb-1 text-[14px] outline-none resize-none no-drag min-h-[56px] max-h-[200px]"
                autoFocus
              />

              {/* 底部工具栏 */}
              <div className="flex items-end justify-between gap-2 px-2.5 pb-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible">
              {!hasSelectedCwd ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleSelectProjectFolder();
                  }}
                  disabled={pendingStart}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--bg-tertiary)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_76%,var(--accent)_24%)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Choose project folder"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Choose project
                </button>
              ) : null}
              <ProjectAgentPicker
                profiles={newSessionAgentProfiles}
                selectedProfile={selectedProjectAgentProfile}
                disabled={pendingStart}
                onSelect={(profileId) => {
                  setSelectedAgentId(profileId);
                  if (cwd && projectAgentProfiles.some((profile) => profile.id === profileId)) {
                    setSelectedProjectAgentForProject(cwd, profileId);
                  }
                }}
              />
              <SavePromptButton content={promptLibraryContent} disabled={pendingStart} />

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
              </div>
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
