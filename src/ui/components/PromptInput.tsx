import { useState, useRef, useEffect, useMemo } from 'react';
import { Paperclip, Plus, ArrowUp, Square } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getSessionModel } from '../utils/session-model';
import {
  formatClaudeModelLabel,
  loadPreferredClaudeContext1m,
  loadPreferredClaudeModel,
  savePreferredClaudeContext1m,
  savePreferredClaudeModel,
  supportsClaude1mContext,
} from '../utils/claude-model';
import { buildCodexModelOptions, formatCodexModelLabel, loadPreferredCodexModel, savePreferredCodexModel } from '../utils/codex-model';

export function PromptInput() {
  const { activeSessionId, sessions, setShowNewSession } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [provider, setProvider] = useState(loadPreferredProvider());
  const [selectedClaudeModel, setSelectedClaudeModel] = useState<string | null>(
    loadPreferredClaudeModel()
  );
  const [selectedClaudeContext1m, setSelectedClaudeContext1m] = useState(loadPreferredClaudeContext1m());
  const [selectedCodexModel, setSelectedCodexModel] = useState<string | null>(
    loadPreferredCodexModel()
  );
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
  const activeClaudeModel = useMemo(
    () => (provider === 'claude' ? activeSession?.model || getSessionModel(activeSession?.messages) : null),
    [provider, activeSession?.messages, activeSession?.model]
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
              ? selectedCodexModel || codexModelConfig.defaultModel || codexModelOptions[0] || undefined
              : undefined,
        betas:
          provider === 'claude' &&
          supportsClaude1mContext(selectedClaudeModel || claudeModelConfig.defaultModel || null) &&
          selectedClaudeContext1m
            ? ['context-1m-2025-08-07']
            : undefined,
      },
    });
    setPrompt('');
    setAttachments([]);
  };
  const skillAutocomplete = useClaudeSkillAutocomplete({
    enabled: provider === 'claude',
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
    if (activeSession?.provider !== 'claude') {
      return;
    }

    const nextModel =
      activeSession.model ||
      activeClaudeModel ||
      loadPreferredClaudeModel() ||
      claudeModelConfig.defaultModel;
    setSelectedClaudeModel(nextModel || null);
    setSelectedClaudeContext1m(
      !!activeSession?.betas?.includes('context-1m-2025-08-07') || loadPreferredClaudeContext1m()
    );
  }, [
    activeSessionId,
    activeSession?.provider,
    activeSession?.model,
    activeSession?.betas,
    activeClaudeModel,
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
    if (activeSession?.provider !== 'codex') {
      return;
    }

    const nextModel =
      activeSession.model ||
      loadPreferredCodexModel() ||
      codexModelConfig.defaultModel ||
      codexModelOptions[0];
    setSelectedCodexModel(nextModel || null);
  }, [
    activeSessionId,
    activeSession?.provider,
    activeSession?.model,
    codexModelConfig.defaultModel,
    codexModelOptions,
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

    if (activeSessionId && activeSession) {
      // 继续现有会话
      sendEvent({
        type: 'session.continue',
        payload: {
          sessionId: activeSessionId,
          prompt: prompt.trim(),
          attachments: attachments.length > 0 ? attachments : undefined,
          provider,
          model:
            provider === 'claude'
              ? selectedClaudeModel || claudeModelConfig.defaultModel || undefined
              : provider === 'codex'
                ? selectedCodexModel || codexModelConfig.defaultModel || codexModelOptions[0] || undefined
                : undefined,
          betas:
            provider === 'claude' &&
            supportsClaude1mContext(selectedClaudeModel || claudeModelConfig.defaultModel || null) &&
            selectedClaudeContext1m
              ? ['context-1m-2025-08-07']
              : undefined,
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
    <div className="p-4 bg-transparent">
      <div className="max-w-4xl mx-auto">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-3xl shadow-sm">
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
            <div className="px-5 pt-4">
              <SelectedClaudeSkillChip
                skill={skillAutocomplete.selectedSkill}
                onClear={skillAutocomplete.clearSelectedSkill}
              />
            </div>
          )}

          {provider === 'claude' && !skillAutocomplete.selectedSkill && skillAutocomplete.selectedCommand && (
            <div className="px-5 pt-4">
              <SelectedClaudeCommandChip
                command={skillAutocomplete.selectedCommand}
                onClear={skillAutocomplete.clearSelectedCommand}
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
                ? `Add instructions for /${skillAutocomplete.selectedSkill.name}...`
                : skillAutocomplete.selectedCommand
                ? `Add instructions for ${skillAutocomplete.selectedCommand.title}...`
                : activeSessionId
                ? 'Continue the conversation...'
                : 'Start a new session...'
            }
            rows={1}
            disabled={isRunning}
            className={`w-full bg-transparent px-5 pb-3 text-[15px] outline-none resize-none min-h-[56px] max-h-[200px] disabled:opacity-50 ${
              skillAutocomplete.selectedSkill || skillAutocomplete.selectedCommand ? 'pt-3' : 'pt-4'
            }`}
          />

          {provider === 'claude' && skillAutocomplete.hasSlashQuery && (
            <ClaudeSkillMenu
              suggestions={skillAutocomplete.suggestions}
              selectedIndex={skillAutocomplete.selectedIndex}
              empty={skillAutocomplete.suggestions.length === 0}
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
                config: claudeModelConfig,
                runtimeModel: activeClaudeModel,
                context1m: selectedClaudeContext1m,
                compatibleOptions,
                onToggleContext1m: (enabled) => {
                  setSelectedClaudeContext1m(enabled);
                  savePreferredClaudeContext1m(enabled);
                },
                onChange: (model) => {
                  setSelectedClaudeModel(model);
                  if (!supportsClaude1mContext(model)) {
                    setSelectedClaudeContext1m(false);
                    savePreferredClaudeContext1m(false);
                  }
                  savePreferredClaudeModel(model);
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
            />

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

            <div className="flex-1" />

            {isRunning ? (
              <button
                onClick={handleStop}
                className="h-9 w-9 rounded-full border border-black bg-black text-white transition-colors hover:bg-[var(--accent-hover)] flex items-center justify-center"
                title="Stop"
                aria-label="Stop"
              >
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim()}
                className="h-9 w-9 rounded-full flex items-center justify-center transition-colors disabled:cursor-not-allowed"
                style={{
                  backgroundColor: !prompt.trim() ? '#848588' : '#000000',
                  color: '#FFFFFF'
                }}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp className="h-4.5 w-4.5" />
              </button>
            )}
          </div>
        </div>

        <div className="text-xs text-[var(--text-muted)] mt-2 px-1">
          {isRunning
            ? 'Session is running. Press Enter or click Stop to abort.'
            : provider === 'claude'
              ? 'Press Enter to send, Shift+Enter for new line. Type / to insert a Claude skill.'
              : 'Press Enter to send, Shift+Enter for new line'}
          {provider === 'claude' && activeClaudeModel
            ? ` Current model: ${formatClaudeModelLabel(activeClaudeModel, selectedClaudeContext1m)}`
            : provider === 'codex' && (activeSession?.model || selectedCodexModel)
              ? ` Current model: ${formatCodexModelLabel(activeSession?.model || selectedCodexModel || '')}`
              : ''}
        </div>
      </div>
    </div>
  );
}
