import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment, ClaudeAccessMode, ClaudeSkillSummary } from '../types';
import coworkLogo from '../assets/cowork-logo.svg';
import powerPointLogo from '../assets/powerpoint-2025-logo.svg';
import pdfLogo from '../assets/pdf-svgrepo-com.svg';
import wordLogo from '../assets/word-2025-logo.svg';
import { AgentModelPicker } from './AgentModelPicker';
import { AttachmentChips } from './AttachmentChips';
import { ClaudeAccessModePicker } from './ClaudeAccessModePicker';
import { ClaudeSkillMenu } from './ClaudeSkillMenu';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useCompatibleProviderConfig } from '../hooks/useCompatibleProviderConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useClaudeSkillAutocomplete } from '../hooks/useClaudeSkillAutocomplete';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';
import { getLatestProviderModel } from '../utils/session-model';
import {
  supportsClaude1mContext,
  loadPreferredClaudeContext1m,
  loadPreferredClaudeModel,
  savePreferredClaudeContext1m,
  savePreferredClaudeModel,
} from '../utils/claude-model';
import { buildCodexModelOptions, loadPreferredCodexModel, savePreferredCodexModel } from '../utils/codex-model';
import { buildPromptWithSkill } from '../utils/claude-skills';
import { buildPromptWithSlashCommand } from '../utils/claude-slash';

const PPTX_QUICK_ACTION_PROMPT = [
  'Create a polished PPTX presentation for this project.',
  '',
  'Content requirements:',
  '- Explain what the app does, who it is for, and the main workflow.',
  '- Summarize the most important capabilities using repo evidence only.',
  '- Include a concise getting-started or how-to-run section if the repo supports it.',
  '',
  'Output requirements:',
  '- Keep the deck concise, visual, and ready to present.',
  '- Generate a .pptx file and include its filename/path in the final reply.',
].join('\n');

const PDF_QUICK_ACTION_PROMPT = [
  'Create a polished PDF document for this project.',
  '',
  'Content requirements:',
  '- Explain what the app does, who it is for, and the main workflow.',
  '- Summarize the most important capabilities using repo evidence only.',
  '- Include a concise getting-started or how-to-run section if the repo supports it.',
  '',
  'Output requirements:',
  '- Keep the document concise, structured, and ready to share.',
  '- Generate a .pdf file and include its filename/path in the final reply.',
].join('\n');

const DOCX_QUICK_ACTION_PROMPT = [
  'Create a polished DOCX document for this project.',
  '',
  'Content requirements:',
  '- Explain what the app does, who it is for, and the main workflow.',
  '- Summarize the most important capabilities using repo evidence only.',
  '- Include a concise getting-started or how-to-run section if the repo supports it.',
  '',
  'Output requirements:',
  '- Keep the document concise, structured, and ready to share.',
  '- Generate a .docx file and include its filename/path in the final reply.',
].join('\n');

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
  const [selectedClaudeContext1m, setSelectedClaudeContext1m] = useState(loadPreferredClaudeContext1m());
  const [selectedCodexModel, setSelectedCodexModel] = useState<string | null>(
    loadPreferredCodexModel()
  );
  const [showCwdHint, setShowCwdHint] = useState(false);
  const [claudeAccessMode, setClaudeAccessMode] = useState<ClaudeAccessMode>('default');
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cwd = projectCwd || '';
  const hasSelectedCwd = cwd.trim().length > 0;
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
    sendEvent({
      type: 'skills.list',
      payload: { projectPath: cwd || undefined },
    });
  }, [cwd]);

  useEffect(() => {
    if (!showCwdHint) return;
    const timer = window.setTimeout(() => setShowCwdHint(false), 1800);
    return () => window.clearTimeout(timer);
  }, [showCwdHint]);

  useEffect(() => {
    if (promptTextareaRef.current) {
      promptTextareaRef.current.style.height = 'auto';
      promptTextareaRef.current.style.height = `${Math.min(promptTextareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt]);

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
    if (supportsClaude1mContext(selectedClaudeModel)) {
      return;
    }
    if (selectedClaudeContext1m) {
      setSelectedClaudeContext1m(false);
      savePreferredClaudeContext1m(false);
    }
  }, [selectedClaudeContext1m, selectedClaudeModel]);

  useEffect(() => {
    if (selectedCodexModel || (!codexModelConfig.defaultModel && codexModelOptions.length === 0)) {
      return;
    }
    setSelectedCodexModel(codexModelConfig.defaultModel || codexModelOptions[0] || null);
  }, [codexModelConfig.defaultModel, codexModelOptions, selectedCodexModel]);

  const pptxSkill = useMemo(
    () => skillAutocomplete.availableSkills.find((skill) => skill.name === 'pptx') || null,
    [skillAutocomplete.availableSkills]
  );
  const pdfSkill = useMemo(
    () => skillAutocomplete.availableSkills.find((skill) => skill.name === 'pdf') || null,
    [skillAutocomplete.availableSkills]
  );
  const docxSkill = useMemo(
    () =>
      skillAutocomplete.availableSkills.find((skill) =>
        ['docx', 'docx-manipulation'].includes(skill.name.toLowerCase())
      ) || null,
    [skillAutocomplete.availableSkills]
  );

  const handleQuickAction = (
    skill: ClaudeSkillSummary | null,
    skillName: string,
    remainder: string
  ) => {
    if (!skill) {
      toast.error(`Install the /${skillName} Claude skill to use this shortcut.`);
      return;
    }

    if (provider !== 'claude') {
      setProvider('claude');
      savePreferredProvider('claude');
    }

    setPrompt(buildPromptWithSkill(skill.name, remainder));
    window.requestAnimationFrame(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    });
  };

  const handleStart = () => {
    if (!prompt.trim()) return;
    if (!hasSelectedCwd) {
      toast.error('Select a project folder before starting a task.');
      setShowCwdHint(true);
      return;
    }

    setPendingStart(true);
    setMenuOpen(false);

    const normalizedPrompt = (
      skillAutocomplete.selectedSkill
        ? buildPromptWithSkill(skillAutocomplete.selectedSkill.name, skillAutocomplete.displayPrompt)
        : skillAutocomplete.selectedCommand
          ? buildPromptWithSlashCommand(skillAutocomplete.selectedCommand.name, skillAutocomplete.displayPrompt)
          : prompt
    ).trim();

    // 用 prompt 前 30 字符作为临时标题（后台会异步生成更好的标题）
    const tempTitle = normalizedPrompt.slice(0, 30) + (normalizedPrompt.length > 30 ? '...' : '');

    // 立即发送开始会话事件
    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: normalizedPrompt,
        cwd: cwd || undefined,
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
        claudeAccessMode: provider === 'claude' ? claudeAccessMode : undefined,
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

  const canStartTask =
    prompt.trim().length > 0 &&
    !pendingStart &&
    hasSelectedCwd;

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
      <div className="flex-1 flex justify-center px-8 pb-4 pt-16">
        <div className="flex h-full w-full max-w-[920px] flex-col">
          <div className="flex flex-1 items-center justify-center text-center">
            <div className="-translate-y-10">
              <div className="mb-7 flex justify-center">
                <img src={coworkLogo} alt="" className="h-16 w-16 select-none opacity-90" aria-hidden="true" />
              </div>

            {/* 标题 */}
              <h1 className="text-[18px] font-bold serif-display leading-tight text-[var(--text-primary)]">
                What can I help you with?
              </h1>

              {!hasSelectedCwd && (
                <div className="mt-5 text-[13px] text-[var(--text-secondary)]">
                  Select a project folder to enable starting a new task.
                </div>
              )}

              <div className="mt-10 flex justify-center">
                <div className="w-full max-w-[520px]">
                  <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-[var(--text-muted)]">
                    Quick paths
                  </div>
                  <div className="flex flex-col items-center gap-2.5">
                    <QuickActionCard
                      title="Create PPTX"
                      description="Presentation deck"
                      logoSrc={powerPointLogo}
                      skill={pptxSkill}
                      fallbackSkillName="pptx"
                      fallbackSkillTitle="PPTX Skill"
                      unavailable={!pptxSkill}
                      onClick={() => handleQuickAction(pptxSkill, 'pptx', PPTX_QUICK_ACTION_PROMPT)}
                    />
                    <QuickActionCard
                      title="Create PDF"
                      description="Shareable document"
                      logoSrc={pdfLogo}
                      skill={pdfSkill}
                      fallbackSkillName="pdf"
                      fallbackSkillTitle="PDF Skill"
                      unavailable={!pdfSkill}
                      onClick={() => handleQuickAction(pdfSkill, 'pdf', PDF_QUICK_ACTION_PROMPT)}
                    />
                    <QuickActionCard
                      title="Create Word"
                      description="DOCX document"
                      logoSrc={wordLogo}
                      skill={docxSkill}
                      fallbackSkillName="docx"
                      fallbackSkillTitle="DOCX Skill"
                      unavailable={!docxSkill}
                      onClick={() => handleQuickAction(docxSkill, 'docx', DOCX_QUICK_ACTION_PROMPT)}
                    />
                  </div>
                </div>
              </div>
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
              <div className="rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-primary)] shadow-sm">
                Select a project folder before starting a new task.
              </div>
            </div>

            {/* Composer */}
            <div className="mx-auto max-w-4xl bg-[var(--bg-secondary)] border border-[var(--border)] rounded-3xl shadow-sm transition-colors">
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

            {provider === 'claude' && !skillAutocomplete.selectedSkill && skillAutocomplete.selectedCommand && (
              <div className="px-5 pt-3">
                <SelectedClaudeCommandChip
                  command={skillAutocomplete.selectedCommand}
                  onClear={skillAutocomplete.clearSelectedCommand}
                  compact
                />
              </div>
            )}

            <textarea
              ref={promptTextareaRef}
              value={skillAutocomplete.displayPrompt}
              onChange={(e) => skillAutocomplete.setDisplayPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                skillAutocomplete.selectedSkill
                  ? `Add instructions for ${skillAutocomplete.selectedSkill.name}...`
                  : skillAutocomplete.selectedCommand
                    ? `Add instructions for ${skillAutocomplete.selectedCommand.title.replace(/^\//, '')}...`
                  : 'Describe your task...'
              }
              rows={1}
              className={`w-full bg-transparent px-5 pb-3 text-[14px] outline-none resize-none no-drag max-h-[200px] ${
                skillAutocomplete.selectedSkill || skillAutocomplete.selectedCommand ? 'pt-1.5 min-h-[56px]' : 'pt-4 min-h-[56px]'
              }`}
              autoFocus
            />

            {provider === 'claude' && skillAutocomplete.hasSlashQuery && (
              <ClaudeSkillMenu
                suggestions={skillAutocomplete.suggestions}
                selectedIndex={skillAutocomplete.selectedIndex}
                empty={skillAutocomplete.suggestions.length === 0}
                onSelect={skillAutocomplete.selectSuggestion}
              />
            )}

            {/* 底部工具栏 */}
            <div className="flex items-center gap-2 px-4 pb-4">
              <AgentModelPicker
                provider={provider}
                onProviderChange={handleProviderChange}
                disabled={pendingStart}
              claudeModel={{
                value: selectedClaudeModel,
                config: claudeModelConfig,
                runtimeModel: pickerClaudeRuntimeModel,
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
                runtimeModel: recentCodexModel,
                onChange: (model) => {
                  setSelectedCodexModel(model);
                  savePreferredCodexModel(model);
                },
              }}
            />

              {provider === 'claude' && (
                <ClaudeAccessModePicker
                  value={claudeAccessMode}
                  onChange={setClaudeAccessMode}
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
                disabled={!canStartTask}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-colors no-drag disabled:cursor-not-allowed"
                style={{
                  backgroundColor: !canStartTask ? '#848588' : '#000000',
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

          </div>
        </div>
      </div>
    </div>
  );
}

function QuickActionCard({
  title,
  description,
  logoSrc,
  skill,
  fallbackSkillName,
  fallbackSkillTitle,
  unavailable,
  onClick,
}: {
  title: string;
  description: string;
  logoSrc: string;
  skill: ClaudeSkillSummary | null;
  fallbackSkillName: string;
  fallbackSkillTitle: string;
  unavailable?: boolean;
  onClick: () => void;
}) {
  const badgeSkill: ClaudeSkillSummary = skill || {
    name: fallbackSkillName,
    title: fallbackSkillTitle,
    description: undefined,
    path: '',
    source: 'user',
  };

  return (
    <button
      type="button"
      aria-disabled={unavailable}
      onClick={onClick}
      className={`group w-full max-w-[320px] rounded-[18px] border bg-[var(--bg-secondary)]/95 px-3.5 py-3 text-left shadow-sm transition-all ${
        unavailable
          ? 'cursor-not-allowed border-[var(--border)] opacity-60'
          : 'border-[var(--border)] hover:-translate-y-0.5 hover:border-black/15 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-white/80 shadow-sm ring-1 ring-black/5 transition-transform group-hover:scale-[1.03]">
          <img src={logoSrc} alt="" className="h-7 w-7" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
            {title}
          </div>
          <div className="mt-0.5 truncate text-[12px] font-medium text-[var(--text-muted)]">
            {unavailable ? `Install /${fallbackSkillName}` : description}
          </div>
        </div>

        <div className="pointer-events-none flex-shrink-0">
          <SelectedClaudeSkillChip skill={badgeSkill} compact />
        </div>
      </div>
    </button>
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
