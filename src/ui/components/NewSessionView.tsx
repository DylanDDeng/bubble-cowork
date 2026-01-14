import { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';

export function NewSessionView() {
  const { pendingStart, setPendingStart } = useAppStore();
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

  const handleStart = async () => {
    if (!prompt.trim()) return;

    setPendingStart(true);

    try {
      // 生成标题
      const title = await window.electron.generateSessionTitle(prompt);

      // 发送开始会话事件
      sendEvent({
        type: 'session.start',
        payload: {
          title,
          prompt: prompt.trim(),
          cwd: cwd || undefined,
        },
      });

      // 清空输入
      setPrompt('');
      setCwd('');
    } catch (error) {
      console.error('Failed to start session:', error);
      setPendingStart(false);
    }
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

          {/* Prompt 输入 */}
          <div className="mb-6">
            <label className="block text-sm text-[var(--text-secondary)] mb-2">
              What would you like to do?
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe your task..."
              rows={5}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm outline-none focus:border-[var(--accent)] resize-none no-drag"
              autoFocus
            />
          </div>

          {/* 按钮 */}
          <div className="flex justify-center">
            <button
              onClick={handleStart}
              disabled={!prompt.trim() || pendingStart}
              className="px-8 py-3 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed no-drag"
            >
              {pendingStart ? 'Starting...' : 'Start Session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
