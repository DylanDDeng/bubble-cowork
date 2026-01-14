import { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { AVAILABLE_MODELS } from '../types';
import type { ModelId } from '../types';

export function NewSessionView() {
  const { pendingStart, setPendingStart, selectedModel, setSelectedModel } = useAppStore();
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [recentCwds, setRecentCwds] = useState<string[]>([]);

  // 加载最近工作目录
  useEffect(() => {
    window.electron.getRecentCwds(8).then(setRecentCwds);
  }, []);

  const handleBrowse = async () => {
    const selected = await window.electron.selectDirectory();
    if (selected) {
      setCwd(selected);
    }
  };

  const handleStart = () => {
    if (!prompt.trim()) return;

    setPendingStart(true);

    // 用 prompt 前 30 字符作为临时标题（后台会异步生成更好的标题）
    const tempTitle = prompt.trim().slice(0, 30) + (prompt.trim().length > 30 ? '...' : '');

    // 立即发送开始会话事件
    sendEvent({
      type: 'session.start',
      payload: {
        title: tempTitle,
        prompt: prompt.trim(),
        cwd: cwd || undefined,
        model: selectedModel,
      },
    });

    // 清空输入
    setPrompt('');
    setCwd('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-xl">
          <h1 className="text-2xl font-semibold mb-8 text-center">Start New Session</h1>

          {/* 工作目录 */}
          <div className="mb-6">
            <label className="block text-sm text-[var(--text-secondary)] mb-2">
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project (optional)"
                className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm outline-none focus:border-[var(--accent)] no-drag"
              />
              <button
                onClick={handleBrowse}
                className="px-4 py-3 rounded-lg text-sm bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors no-drag"
              >
                Browse...
              </button>
            </div>

            {/* 最近目录 */}
            {recentCwds.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-[var(--text-muted)] mb-2">Recent:</div>
                <div className="flex flex-wrap gap-2">
                  {recentCwds.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => setCwd(dir)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors truncate max-w-[200px] no-drag"
                      title={dir}
                    >
                      {dir.split('/').pop() || dir}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Composer - Prompt 输入 + 工具栏 */}
          <div className="mb-6">
            <label className="block text-sm text-[var(--text-secondary)] mb-2">
              What would you like to do?
            </label>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus-within:border-[var(--accent)] transition-colors">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Describe your task..."
                rows={5}
                className="w-full bg-transparent px-4 py-3 text-sm outline-none resize-none no-drag"
                autoFocus
              />
              {/* 底部工具栏 */}
              <div className="flex items-center gap-3 px-3 py-2 border-t border-[var(--border)]">
                <ModelPicker
                  value={selectedModel}
                  onChange={setSelectedModel}
                />
                <div className="flex-1" />
                <button
                  onClick={handleStart}
                  disabled={!prompt.trim() || pendingStart}
                  className="px-6 py-1.5 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed no-drag"
                >
                  {pendingStart ? 'Starting...' : 'Start Session'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Inline Model Picker 组件
function ModelPicker({
  value,
  onChange,
}: {
  value: ModelId;
  onChange: (m: ModelId) => void;
}) {
  const [open, setOpen] = useState(false);
  const model = AVAILABLE_MODELS.find((m) => m.id === value);

  return (
    <div className="relative no-drag">
      <button
        onClick={() => setOpen(!open)}
        className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border)] flex items-center gap-1.5 transition-colors"
      >
        <span className="text-[var(--text-secondary)]">{model?.displayName}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <>
          {/* 点击外部关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full mt-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[180px] z-20">
            {AVAILABLE_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-tertiary)] transition-colors ${
                  m.id === value ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'
                }`}
              >
                {m.displayName}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 下拉箭头图标
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
