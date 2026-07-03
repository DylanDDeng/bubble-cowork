import { useMemo } from 'react';
import * as DropdownMenu from '@/ui/components/ui/dropdown-menu';
import { GitFork, Minus, Plus } from './icons';
import type { AgentProvider } from '../types';
import { PROVIDERS } from '../utils/provider';
import { AgentIcon } from './ComposerAgentControls';
import { useAgentReadiness, type AgentReadinessEntry } from '../hooks/useAgentReadiness';

export type FanOutSelection = Partial<Record<AgentProvider, number>>;

export const MAX_FAN_OUT_MEMBERS = 6;
const MAX_PER_PROVIDER = 3;

export function fanOutTotal(selection: FanOutSelection): number {
  return Object.values(selection).reduce((sum, count) => sum + (count || 0), 0);
}

// 加法控件：不改动现有单选 agent picker 的任何路径。选择为空 = 常规提交路径。
// 选中 ≥1 个成员 = 提交走 fan-out（每个成员一个隔离 worktree + 一个 session）。
export function ComposerFanOutPicker({
  value,
  disabled,
  menuSide = 'top',
  onChange,
}: {
  value: FanOutSelection;
  disabled?: boolean;
  menuSide?: 'top' | 'bottom';
  onChange: (next: FanOutSelection) => void;
}) {
  const { entries } = useAgentReadiness(null, true);
  const readinessByProvider = useMemo(() => {
    const map = new Map<AgentProvider, AgentReadinessEntry>();
    entries.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [entries]);

  const total = fanOutTotal(value);

  const setCount = (provider: AgentProvider, count: number) => {
    const clamped = Math.max(0, Math.min(MAX_PER_PROVIDER, count));
    const next: FanOutSelection = { ...value };
    if (clamped === 0) {
      delete next[provider];
    } else {
      next[provider] = clamped;
    }
    if (fanOutTotal(next) > MAX_FAN_OUT_MEMBERS) return;
    onChange(next);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
            total > 0
              ? 'text-[var(--accent)] hover:text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
          title={
            total > 0
              ? `Fan out to ${total} agent${total > 1 ? 's' : ''} in isolated worktrees`
              : 'Fan out: run this prompt across multiple agents in isolated worktrees'
          }
          aria-label="Fan out to multiple agents"
        >
          <GitFork className="h-4 w-4 flex-shrink-0" />
          {total > 0 ? <span className="font-medium">{total}</span> : null}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side={menuSide}
          sideOffset={8}
          className="z-50 w-[280px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-primary)] p-1.5 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
            Fan out — each agent runs in its own git worktree
          </div>
          {PROVIDERS.map((providerItem) => {
            const provider = providerItem.id;
            const readiness = readinessByProvider.get(provider);
            // 与单选控件同语义：readiness 可能过期，只有确认未安装才禁用
            const missing = readiness?.state === 'missing';
            const count = value[provider] || 0;
            return (
              <div
                key={provider}
                className={`flex items-center gap-2 rounded-[var(--radius-lg)] px-2.5 py-2 transition-colors hover:bg-[var(--bg-tertiary)] ${
                  missing ? 'opacity-40' : ''
                }`}
              >
                <button
                  type="button"
                  disabled={missing}
                  onClick={() => setCount(provider, count > 0 ? 0 : 1)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none disabled:cursor-not-allowed"
                >
                  <AgentIcon provider={provider} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                      {providerItem.label}
                    </span>
                    {readiness && readiness.state !== 'ready' && readiness.state !== 'checking' ? (
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        {readiness.summary}
                      </span>
                    ) : null}
                  </span>
                </button>
                {count > 0 ? (
                  <span className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCount(provider, count - 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                      aria-label={`Fewer ${providerItem.label} agents`}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-4 text-center text-[12px] font-medium text-[var(--text-primary)]">
                      {count}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCount(provider, count + 1)}
                      disabled={count >= MAX_PER_PROVIDER || total >= MAX_FAN_OUT_MEMBERS}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={`More ${providerItem.label} agents`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
          {total > 0 ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className="text-[11px] text-[var(--text-muted)]">
                  {total}/{MAX_FAN_OUT_MEMBERS} agents · full access inside worktrees
                </span>
                <button
                  type="button"
                  onClick={() => onChange({})}
                  className="text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                >
                  Clear
                </button>
              </div>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
