import { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { Attachment } from '../types';
import { AttachmentChips } from './AttachmentChips';
import { ProviderPicker } from './ProviderPicker';
import { loadPreferredProvider, savePreferredProvider } from '../utils/provider';

export function NewSessionView() {
  const { pendingStart, setPendingStart, setProjectCwd } = useAppStore();
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [provider, setProvider] = useState(loadPreferredProvider());

  // 加载最近工作目录
  useEffect(() => {
    window.electron.getRecentCwds(8).then(setRecentCwds);
  }, []);

  const handleStart = () => {
    if (!prompt.trim()) return;

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
      },
    });

    // 清空输入
    setPrompt('');
    setCwd('');
    setAttachments([]);
  };

  const handleCwdChange = (next: string) => {
    setCwd(next);
    if (next) {
      setProjectCwd(next);
    }
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
    if (e.key === 'Enter' && !e.shiftKey && prompt.trim() && !pendingStart) {
      e.preventDefault();
      handleStart();
    }
  };

  return (
    <div className="flex-1 flex flex-col dot-pattern">
      {/* 顶部拖拽区域 */}
      <div className="h-8 drag-region flex-shrink-0" />

      {/* 内容区域 */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* 标题 */}
          <h1 className="text-4xl font-bold serif-display leading-tight mb-6 text-center text-[var(--text-primary)]">
            What can I help you with?
          </h1>

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
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your task..."
              rows={4}
              className="w-full bg-transparent px-5 pt-4 pb-3 text-[15px] outline-none resize-none no-drag"
              autoFocus
            />

            {/* 底部工具栏 */}
            <div className="flex items-center gap-2 px-4 pb-4">
              <CwdPicker
                value={cwd}
                onChange={handleCwdChange}
                recentCwds={recentCwds}
              />

              <ProviderPicker
                value={provider}
                onChange={handleProviderChange}
                disabled={pendingStart}
              />

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
                disabled={!prompt.trim() || pendingStart}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-colors no-drag disabled:cursor-not-allowed"
                style={{
                  backgroundColor: (!prompt.trim() || pendingStart) ? '#848588' : '#000000',
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
          {recentCwds.length > 0 && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {recentCwds.slice(0, 6).map((dir) => (
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
  );
}

// CWD Picker 组件
function CwdPicker({
  value,
  onChange,
  recentCwds,
}: {
  value: string;
  onChange: (v: string) => void;
  recentCwds: string[];
}) {
  const [open, setOpen] = useState(false);
  const displayName = value ? value.split('/').pop() : 'No folder';

  const handleBrowse = async () => {
    const selected = await window.electron.selectDirectory();
    if (selected) {
      onChange(selected);
    }
    setOpen(false);
  };

  return (
    <div className="relative no-drag">
      <button
        onClick={() => setOpen(!open)}
        className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--border)] border border-transparent flex items-center gap-1.5 transition-colors"
      >
        <FolderIcon />
        <span className="text-[var(--text-secondary)] max-w-[120px] truncate">
          {displayName}
        </span>
        <ChevronDownIcon />
      </button>

      {open && (
        <>
          {/* 点击外部关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[220px] max-h-[300px] overflow-y-auto z-20">
            {/* Browse 选项 */}
            <button
              onClick={handleBrowse}
              className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2"
            >
              <FolderPlusIcon />
              <span>Browse...</span>
            </button>

            {recentCwds.length > 0 && (
              <>
                <div className="border-t border-[var(--border)] my-1" />
                <div className="px-3 py-1 text-xs text-[var(--text-muted)]">Recent</div>
                {recentCwds.map((dir) => (
                  <button
                    key={dir}
                    onClick={() => {
                      onChange(dir);
                      setOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] transition-colors truncate ${
                      dir === value ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                    }`}
                    title={dir}
                  >
                    {dir}
                  </button>
                ))}
              </>
            )}

            {value && (
              <>
                <div className="border-t border-[var(--border)] my-1" />
                <button
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-muted)]"
                >
                  Clear selection
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Icons
function FolderIcon() {
  return (
    <svg
      className="w-4 h-4 text-[var(--text-muted)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      className="w-4 h-4 text-[var(--text-muted)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-[var(--text-muted)]"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
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
