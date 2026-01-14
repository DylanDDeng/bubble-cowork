import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';

export function StartSessionModal() {
  const { showStartModal, setShowStartModal, pendingStart, setPendingStart } = useAppStore();
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [recentCwds, setRecentCwds] = useState<string[]>([]);

  // 加载最近工作目录
  useEffect(() => {
    if (showStartModal) {
      window.electron.getRecentCwds(8).then(setRecentCwds);
    }
  }, [showStartModal]);

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
    <Dialog.Root open={showStartModal} onOpenChange={setShowStartModal}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-6 w-[560px] max-h-[90vh] overflow-y-auto shadow-xl">
          <Dialog.Title className="text-xl font-semibold mb-4">
            Start New Session
          </Dialog.Title>

          {/* 工作目录 */}
          <div className="mb-4">
            <label className="block text-sm text-[var(--text-secondary)] mb-2">
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/project (optional)"
                className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={handleBrowse}
                className="px-4 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
              >
                Browse...
              </button>
            </div>

            {/* 最近目录 */}
            {recentCwds.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-[var(--text-muted)] mb-1">Recent:</div>
                <div className="flex flex-wrap gap-1">
                  {recentCwds.map((dir) => (
                    <button
                      key={dir}
                      onClick={() => setCwd(dir)}
                      className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border)] transition-colors truncate max-w-[200px]"
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
              rows={4}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)] resize-none"
              autoFocus
            />
          </div>

          {/* 按钮 */}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowStartModal(false)}
              className="px-4 py-2 rounded-lg text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleStart}
              disabled={!prompt.trim() || pendingStart}
              className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pendingStart ? 'Starting...' : 'Start Session'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
