import { useState, useRef, useEffect, useMemo } from 'react';
import { Paperclip, Plus, Square } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment, ClaudeAccessMode, ClaudeCompatibleProviderId } from '../types';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeAccessModePicker } from './ClaudeAccessModePicker';
import { ClaudeContextIndicator } from './ClaudeContextIndicator';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useOpencodeRuntimeStatus } from '../hooks/useOpencodeRuntimeStatus';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getSessionModel } from '../utils/session-model';
import {
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
import { buildCodexModelOptions, formatCodexModelLabel, loadPreferredCodexModel, savePreferredCodexModel } from '../utils/codex-model';
import { buildOpencodeModelOptions, loadPreferredOpencodeModel, savePreferredOpencodeModel } from '../utils/opencode-model';
import { buildPromptWithSkill } from '../utils/claude-skills';
import { buildPromptWithSlashCommand } from '../utils/claude-slash';
import { getLatestClaudeContextSnapshot } from '../utils/context-usage';

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

export function PromptInput() {
  const { activeSessionId, sessions, setShowNewSession } = useAppStore();
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const isRunning = activeSession?.status === 'running';
  const claudeModelConfig = useClaudeModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const availableClaudeModels = useMemo(
    () => Array.from(new Set([...claudeModelConfig.options, ...compatibleOptions.map((option) => option.model)])),
    [claudeModelConfig.options, compatibleOptions]
  );
  const codexModelConfig = useCodexModelConfig();
  const codexModelOptions = useMemo(
    () => buildCodexModelOptions(codexModelConfig),
    [codexModelConfig]
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
  const contextSnapshot = useMemo(
    () => {
      if (activeSession?.provider !== 'claude') {
        return null;
      }

      const fromMessages = getLatestClaudeContextSnapshot(
        activeSession.messages,
        activeSession.model || visibleActiveClaudeModel || selectedClaudeModel
      );
      if (fromMessages) {
        return fromMessages;
      }

      const latest = activeSession.latestClaudeModelUsage;
      if (!latest?.usage) {
        return null;
      }

      const cacheReadTokens = latest.usage.cacheReadInputTokens || 0;
      const cacheCreationTokens = latest.usage.cacheCreationInputTokens || 0;
      const inputTokens = latest.usage.inputTokens || 0;
      const outputTokens = latest.usage.outputTokens || 0;

      return {
        model: latest.model,
        total: latest.usage.contextWindow || 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        maxOutputTokens: latest.usage.maxOutputTokens || 0,
        webSearchRequests: latest.usage.webSearchRequests || 0,
      };
    },
    [
      activeSession?.latestClaudeModelUsage,
      activeSession?.messages,
      activeSession?.model,
      activeSession?.provider,
      selectedClaudeModel,
      visibleActiveClaudeModel,
    ]
  );
  const handleAutoSubmitClaudeCommand = (nextPrompt: string) => {
    if (!activeSessionId || !activeSession) {
      setPrompt(nextPrompt);
      return;
    }

    setMenuOpen(false);
    sendEvent({
      type: 'session.continue',
      payload: {
        sessionId: activeSessionId,
        prompt: nextPrompt,
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
      },
    });
    setPrompt('');
    setAttachments([]);
  };
  const skillAutocomplete = useClaudeSkillAutocomplete({
    enabled: true,
    enableSkills: provider === 'claude',
    provider,
    prompt,
    projectPath: activeSession?.cwd,
    sessionMessages: activeSession?.messages || [],
    setPrompt,
    onAutoSubmitCommand: handleAutoSubmitClaudeCommand,
  });

  useEffect(() => {
    if (activeSession?.provider) {
      setProvider(activeSession.provider);
      savePreferredProvider(activeSession.provider);
    }
  }, [activeSessionId, activeSession?.provider]);

  useEffect(() => {
    if (activeSession?.provider === 'claude') {
      setSelectedClaudeAccessMode(activeSession.claudeAccessMode || 'default');
      return;
    }

    if (!activeSessionId) {
      setSelectedClaudeAccessMode('default');
    }
  }, [activeSession?.claudeAccessMode, activeSession?.provider, activeSessionId]);

  useEffect(() => {
    if (activeSession?.provider !== 'claude') {
      return;
    }

    const nextModel =
      visibleActiveClaudeModel ||
      loadPreferredClaudeModel() ||
      claudeModelConfig.defaultModel;
    setSelectedClaudeModel(nextModel || null);
    setSelectedClaudeCompatibleProviderId(
      activeSession.compatibleProviderId || loadPreferredClaudeCompatibleProviderId()
    );
    setSelectedClaudeContext1m(
      !!activeSession?.betas?.includes('context-1m-2025-08-07') || loadPreferredClaudeContext1m()
    );
  }, [
    activeSessionId,
    activeSession?.provider,
    activeSession?.model,
    activeSession?.compatibleProviderId,
    activeSession?.betas,
    visibleActiveClaudeModel,
    claudeModelConfig.defaultModel,
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

    const nextModel =
      activeSession.model ||
      loadPreferredCodexModel() ||
      codexModelOptions[0];
    if ((nextModel || null) !== selectedCodexModel) {
      setSelectedCodexModel(nextModel || null);
    }
  }, [
    activeSessionId,
    activeSession?.provider,
    activeSession?.model,
    codexModelOptions,
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
    activeSessionId,
    activeSession?.provider,
    activeSession?.model,
    opencodeModelOptions,
  ]);


  // 自动调整高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt]);

  const handleSend = async () => {
    if (!prompt.trim()) return;
    setMenuOpen(false);

    const normalizedPrompt = (
      skillAutocomplete.selectedSkill
        ? buildPromptWithSkill(skillAutocomplete.selectedSkill.name, skillAutocomplete.displayPrompt)
        : skillAutocomplete.selectedCommand
          ? buildPromptWithSlashCommand(skillAutocomplete.selectedCommand.name, skillAutocomplete.displayPrompt)
          : prompt
    ).trim();

    if (activeSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
          sessionId: activeSessionId,
          prompt: normalizedPrompt,
          attachments: attachments.length > 0 ? attachments : undefined,
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
    if (activeSessionId) {
      sendEvent({
        type: 'session.stop',
        payload: { sessionId: activeSessionId },
      });
    }
  };

  const handleAddAttachments = async () => {
    if (isRunning) return;
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

    if (
      (skillAutocomplete.selectedSkill || skillAutocomplete.selectedCommand) &&
      skillAutocomplete.displayPrompt.length === 0 &&
      e.key === 'Backspace'
    ) {
      e.preventDefault();
      if (skillAutocomplete.selectedSkill) {
        skillAutocomplete.clearSelectedSkill();
      } else {
        skillAutocomplete.clearSelectedCommand();
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isRunning) {
        handleStop();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="bg-transparent">
      <div className="mx-auto max-w-4xl">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[22px] shadow-sm transition-colors">
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

          {provider === 'claude' && skillAutocomplete.selectedSkill && (
            <div className="px-5 pt-3">
              <SelectedClaudeSkillChip
                skill={skillAutocomplete.selectedSkill}
                onClear={skillAutocomplete.clearSelectedSkill}
                compact
              />
            </div>
          )}

          {!skillAutocomplete.selectedSkill && skillAutocomplete.selectedCommand && (
            <div className="px-5 pt-3">
              <SelectedClaudeCommandChip
                command={skillAutocomplete.selectedCommand}
                onClear={skillAutocomplete.clearSelectedCommand}
                compact
              />
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={skillAutocomplete.displayPrompt}
            onChange={(e) => skillAutocomplete.setDisplayPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isRunning
                ? 'Press Enter to stop...'
                : skillAutocomplete.selectedSkill
                ? `Add instructions for ${skillAutocomplete.selectedSkill.name}...`
                : skillAutocomplete.selectedCommand
                ? `Add instructions for ${skillAutocomplete.selectedCommand.title.replace(/^\//, '')}...`
                : activeSessionId
                ? 'Continue the conversation...'
                : 'Start a new session...'
            }
            rows={1}
            disabled={isRunning}
            className={`w-full bg-transparent px-5 pb-3 text-[14px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50 ${
              skillAutocomplete.selectedSkill || skillAutocomplete.selectedCommand ? 'pt-1.5' : 'pt-4'
            }`}
          />

          {skillAutocomplete.hasSlashQuery && (
            <ClaudeSkillMenu
              suggestions={skillAutocomplete.suggestions}
              selectedIndex={skillAutocomplete.selectedIndex}
              empty={skillAutocomplete.suggestions.length === 0}
              title={provider === 'claude' ? 'Commands & Skills' : 'Commands'}
              emptyMessage={
                provider === 'claude'
                  ? 'No matching Claude commands or skills.'
                  : 'No matching ACP slash commands.'
              }
              onSelect={skillAutocomplete.selectSuggestion}
            />
          )}

          <div className="flex items-center gap-2 px-4 pb-4">
            <AgentModelPicker
              provider={provider}
              onProviderChange={(next) => {
                setProvider(next);
                savePreferredProvider(next);
              }}
              disabled={isRunning}
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
                runtimeModel: activeSession?.provider === 'codex' ? activeSession.model || selectedCodexModel : null,
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

            {provider === 'claude' && (
              <ClaudeAccessModePicker
                value={selectedClaudeAccessMode}
                onChange={setSelectedClaudeAccessMode}
                disabled={isRunning}
              />
            )}

            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                disabled={isRunning}
                className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Add"
                aria-label="Add"
              >
                <Plus className="w-5 h-5" />
              </button>

              {menuOpen && !isRunning && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute bottom-full mb-2 left-0 z-30 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-lg p-1 min-w-[220px]">

                    <button
                      onClick={async () => {
                        setMenuOpen(false);
                        await handleAddAttachments();
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-[var(--text-primary)]"
                    >
                      <Paperclip className="w-4 h-4" />
                      <span>Add files or photos</span>
                    </button>
                  </div>
                </>
                )}
              </div>

            {provider === 'claude' && (
              <ClaudeContextIndicator
                snapshot={contextSnapshot}
                modelLabel={selectedClaudeModel || visibleActiveClaudeModel || activeSession?.model || 'Claude'}
                emptyMessage="Starts tracking after the first Claude response"
              />
            )}

            <div className="flex-1" />

            {isRunning ? (
              <button
                onClick={handleStop}
                className="flex h-10 w-10 items-center justify-center rounded-[14px] border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                title="Stop"
                aria-label="Stop"
              >
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-[14px] transition-colors disabled:cursor-not-allowed"
                style={{
                  backgroundColor: !prompt.trim() ? 'var(--text-muted)' : 'var(--accent)',
                  color: !prompt.trim() ? 'var(--bg-primary)' : 'var(--accent-foreground)'
                }}
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
