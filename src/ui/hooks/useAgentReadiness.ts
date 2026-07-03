import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProvider, AgentRuntimeDirectoryReport, AgentRuntimeEntry } from '../types';

export type AgentReadinessState =
  | 'checking'
  | 'ready'
  | 'needs_login'
  | 'needs_config'
  | 'missing'
  | 'error';

export interface AgentReadinessEntry {
  provider: AgentProvider;
  label: string;
  state: AgentReadinessState;
  summary: string;
  detail: string;
  command?: string | null;
}

export interface AgentReadinessResult {
  entries: AgentReadinessEntry[];
  readyCount: number;
  setupCount: number;
  loading: boolean;
  refresh: () => void;
}

const PROVIDER_ORDER: Array<{ provider: AgentProvider; label: string }> = [
  { provider: 'claude', label: 'Claude Code' },
  { provider: 'codex', label: 'Codex CLI' },
  { provider: 'opencode', label: 'OpenCode' },
  { provider: 'kimi', label: 'Kimi Code' },
  { provider: 'grok', label: 'Grok Build' },
  { provider: 'pi', label: 'Pi' },
];

// Shared across hook instances: several pickers/panels mount at once and the
// probe spawns real CLI processes, so fetch the directory once and share it.
let cachedReport: AgentRuntimeDirectoryReport | null = null;
let inflight: Promise<AgentRuntimeDirectoryReport> | null = null;
const CACHE_TTL_MS = 30_000;
const subscribers = new Set<(report: AgentRuntimeDirectoryReport) => void>();

function fetchDirectory(force: boolean): Promise<AgentRuntimeDirectoryReport> {
  if (!force && cachedReport && Date.now() - cachedReport.checkedAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedReport);
  }
  if (!inflight) {
    inflight = window.electron
      .getAgentRuntimeDirectory(force)
      .then((report) => {
        cachedReport = report;
        subscribers.forEach((notify) => notify(report));
        return report;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function toReadinessEntry(entry: AgentRuntimeEntry): AgentReadinessEntry {
  const state: AgentReadinessState =
    entry.state === 'ready'
      ? 'ready'
      : entry.state === 'login_required'
        ? 'needs_login'
        : entry.state === 'not_installed'
          ? 'missing'
          : 'error';
  return {
    provider: entry.provider,
    label: entry.title,
    state,
    summary:
      state === 'ready'
        ? 'Ready'
        : state === 'needs_login'
          ? 'Login required'
          : state === 'missing'
            ? 'Runtime missing'
            : entry.summary || 'Check failed',
    detail: entry.detail || entry.summary,
    command: entry.state === 'not_installed' ? entry.installCommand : entry.loginCommand,
  };
}

function checkingEntries(): AgentReadinessEntry[] {
  return PROVIDER_ORDER.map(({ provider, label }) => ({
    provider,
    label,
    state: 'checking' as const,
    summary: `Checking ${label}`,
    detail: 'Verifying runtime and authentication.',
  }));
}

export function useAgentReadiness(
  _claudeModel?: string | null,
  enabled = true
): AgentReadinessResult {
  const [report, setReport] = useState<AgentRuntimeDirectoryReport | null>(cachedReport);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const notify = (next: AgentRuntimeDirectoryReport) => setReport(next);
    subscribers.add(notify);
    return () => {
      subscribers.delete(notify);
    };
  }, []);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      const next = await fetchDirectory(force);
      setReport(next);
    } catch {
      // keep whatever we had; a failed probe shouldn't blank the picker
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void load(false);
    }
  }, [enabled, load]);

  const entries = useMemo(
    () => (report ? report.entries.map(toReadinessEntry) : checkingEntries()),
    [report]
  );

  return {
    entries,
    readyCount: entries.filter((entry) => entry.state === 'ready').length,
    setupCount: entries.filter((entry) => entry.state !== 'ready' && entry.state !== 'checking').length,
    loading: loading || !report,
    refresh: () => {
      void load(true);
    },
  };
}
