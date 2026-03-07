import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeModelPicker } from './ClaudeModelPicker';
import { ProviderPicker } from './ProviderPicker';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getLatestProviderModel } from '../utils/session-model';
import { formatClaudeModelLabel, loadPreferredClaudeModel, savePreferredClaudeModel } from '../utils/claude-model';

export function NewSessionView() {
  const { pendingStart, projectCwd, sessions, setPendingStart, setProjectCwd } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [provider, setProvider] = useState(loadPreferredProvider());
  const [selectedClaudeModel, setSelectedClaudeModel] = useState<string | null>(
    loadPreferredClaudeModel()
  );
  const [showCwdHint, setShowCwdHint] = useState(false);
  const cwd = projectCwd || '';
  const hasSelectedCwd = cwd.trim().length > 0;
  const claudeModelConfig = useClaudeModelConfig();
  const recentClaudeModel = useMemo(
    () => getLatestProviderModel(sessions, 'claude'),
    [sessions]
  );
  const recentProjectOptions = useMemo(() => {
    if (!cwd) {
      return recentCwds.slice(0, 6);
    }

    const next = [cwd, ...recentCwds.filter((dir) => dir !== cwd)];
    return next.slice(0, 6);
  }, [cwd, recentCwds]);
  const skillAutocomplete = useClaudeSkillAutocomplete({
    enabled: provider === 'claude',
    prompt,
    projectPath: cwd || undefined,
    setPrompt,
  });

  // 加载最近工作目录
  useEffect(() => {
    window.electron.getRecentCwds(8).then(setRecentCwds);
  }, []);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = window.setTimeout(() => setShowCwdHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showCwdHint]);

  useEffect(() => {
    if (selectedClaudeModel || !claudeModelConfig.defaultModel) {
      return;
    }
    setSelectedClaudeModel(claudeModelConfig.defaultModel);
  }, [claudeModelConfig.defaultModel, selectedClaudeModel]);

  const handleStart = () => {
    if (!prompt.trim()) return;
    if (!hasSelectedCwd) {
      toast.error('Select a project folder before starting a task.');
      setShowCwdHint(true);
      return;
    }

    setPendingStart(true);
    setMenuOpen(false);

    // 用 prompt 前 30 字符作为临时标题（后台会异步生成更好的标题）
    const tempTitle = prompt.trim().slice(0, 30) + (prompt.trim().length > 30 ? '...' : '');

    // 立即发送开始会话事件
    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: prompt.trim(),
        cwd: cwd || undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        provider,
        model:
          provider === 'claude'
            ? selectedClaudeModel || claudeModelConfig.defaultModel || undefined
            : undefined,
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

  const handleProviderChange = (next: typeof provider) => {
    setProvider(next);
    savePreferredProvider(next);
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
        skillAutocomplete.selectCurrentSkill();
        return;
      }
    }

    if (
      skillAutocomplete.selectedSkill &&
      skillAutocomplete.displayPrompt.length === 0 &&
      e.key === 'Backspace'
    ) {
      e.preventDefault();
      skillAutocomplete.clearSelectedSkill();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && prompt.trim() && !pendingStart) {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      {/* 顶部拖拽区域 */}
      <div className="h-8 drag-region flex-shrink-0" />

      {/* 内容区域 */}
      <div className="flex-1 flex justify-center px-8 pb-10 pt-16">
        <div className="flex h-full w-full max-w-2xl flex-col">
          <div className="flex flex-1 items-center justify-center text-center">
            <div className="-translate-y-12">
            {/* 标题 */}
              <h1 className="text-4xl font-bold serif-display leading-tight text-[var(--text-primary)]">
                What can I help you with?
              </h1>

              {provider === 'claude' && (
                <div className="mt-4 text-xs text-[var(--text-muted)]">
                  Type <span className="font-mono">/</span> to browse Claude skills for this session.
                  {recentClaudeModel ? ` Last detected model: ${formatClaudeModelLabel(recentClaudeModel)}.` : ''}
                </div>
              )}

              {!hasSelectedCwd && (
                <div className="mt-3 text-xs text-[var(--text-secondary)]">
                  Select a project folder to enable starting a new task.
                </div>
              )}
            </div>
          </div>

          <div className="mt-auto">
            <div
              className={`mb-3 flex justify-center transition-all duration-200 ${
                showCwdHint ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1 pointer-events-none'
              }`}
            >
              <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-sm">
                Select a project folder before starting a new task.
              </div>
            </div>

            {/* Composer */}
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-3xl shadow-sm transition-colors">
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

            <textarea
              value={skillAutocomplete.displayPrompt}
              onChange={(e) => skillAutocomplete.setDisplayPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                skillAutocomplete.selectedSkill
                  ? `Add instructions for /${skillAutocomplete.selectedSkill.name}...`
                  : 'Describe your task...'
              }
              rows={4}
              className={`w-full bg-transparent px-5 pb-3 text-[15px] outline-none resize-none no-drag ${
                skillAutocomplete.selectedSkill ? 'pt-3' : 'pt-4'
              }`}
              autoFocus
            />

            {provider === 'claude' && skillAutocomplete.hasSlashQuery && (
              <ClaudeSkillMenu
                suggestions={skillAutocomplete.suggestions}
                selectedIndex={skillAutocomplete.selectedIndex}
                empty={skillAutocomplete.suggestions.length === 0}
                onSelect={skillAutocomplete.selectSkill}
              />
            )}

            {/* 底部工具栏 */}
            <div className="flex items-center gap-2 px-4 pb-4">
              <ProviderPicker
                value={provider}
                onChange={handleProviderChange}
                disabled={pendingStart}
              />

              {provider === 'claude' && (
                <ClaudeModelPicker
                  value={selectedClaudeModel}
                  config={claudeModelConfig}
                  runtimeModel={recentClaudeModel}
                  onChange={(model) => {
                    setSelectedClaudeModel(model);
                    savePreferredClaudeModel(model);
                  }}
                  disabled={pendingStart}
                />
              )}

              <div className="relative no-drag">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={pendingStart}
                  className="p-2 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                    <div className="absolute bottom-full mb-2 left-0 z-30 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-lg p-1 min-w-[220px]">
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
                    </div>
                  </>
                )}
              </div>

              <div className="flex-1" />
              <button
                onClick={handleStart}
                disabled={!prompt.trim() || pendingStart || !hasSelectedCwd}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-colors no-drag disabled:cursor-not-allowed"
                style={{
                  backgroundColor: (!prompt.trim() || pendingStart || !hasSelectedCwd) ? '#848588' : '#000000',
                  color: '#FFFFFF'
                }}
              >
                {pendingStart ? (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ArrowUpIcon />
                )}
              </button>
            </div>
            </div>

            {/* Recent Projects */}
            {recentProjectOptions.length > 0 && (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {recentProjectOptions.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => handleCwdChange(dir)}
                    className={`text-xs px-3 py-1.5 rounded-full transition-colors no-drag ${
                      cwd === dir
                        ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]'
                    }`}
                    title={dir}
                  >
                    {dir.split('/').pop() || dir}
                  </button>
                ))}
              </div>
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
