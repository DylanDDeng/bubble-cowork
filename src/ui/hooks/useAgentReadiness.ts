import { useMemo } from 'react';
import type {
  AgentProvider,
  ClaudeRuntimeStatus,
  CodexRuntimeStatus,
  OpenCodeRuntimeStatus,
} from '../types';
import { useClaudeRuntimeStatus } from './useClaudeRuntimeStatus';
import { useCodexRuntimeStatus } from './useCodexRuntimeStatus';
import { useOpencodeRuntimeStatus } from './useOpencodeRuntimeStatus';

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

export function useAgentReadiness(
  claudeModel?: string | null,
  enabled = true
): AgentReadinessResult {
  const {
    status: claudeStatus,
    loading: claudeLoading,
    refresh: refreshClaude,
  } = useClaudeRuntimeStatus(claudeModel ?? null, enabled);
  const {
    status: codexStatus,
    loading: codexLoading,
    refresh: refreshCodex,
  } = useCodexRuntimeStatus(enabled);
  const {
    status: opencodeStatus,
    loading: opencodeLoading,
    refresh: refreshOpencode,
  } = useOpencodeRuntimeStatus(enabled);

  const claudeChecking = enabled && (claudeLoading || claudeStatus.checkedAt === 0);
  const codexChecking = enabled && (codexLoading || codexStatus.checkedAt === 0);
  const opencodeChecking = enabled && (opencodeLoading || opencodeStatus.checkedAt === 0);

  const entries = useMemo(
    () => [
      buildAegisEntry(),
      buildClaudeEntry(claudeStatus, claudeChecking),
      buildCodexEntry(codexStatus, codexChecking),
      buildOpencodeEntry(opencodeStatus, opencodeChecking),
    ],
    [
      claudeChecking,
      claudeStatus,
      codexChecking,
      codexStatus,
      opencodeChecking,
      opencodeStatus,
    ]
  );

  return {
    entries,
    readyCount: entries.filter((entry) => entry.state === 'ready').length,
    setupCount: entries.filter((entry) => entry.state !== 'ready' && entry.state !== 'checking').length,
    loading: claudeChecking || codexChecking || opencodeChecking,
    refresh: () => {
      refreshClaude();
      refreshCodex();
      refreshOpencode();
    },
  };
}

function buildAegisEntry(): AgentReadinessEntry {
  return {
    provider: 'aegis',
    label: 'Aegis Built-in',
    state: 'ready',
    summary: 'Ready',
    detail: 'Runs through the built-in Aegis coding agent runtime.',
  };
}

function buildClaudeEntry(
  status: ClaudeRuntimeStatus,
  loading: boolean
): AgentReadinessEntry {
  if (loading) {
    return {
      provider: 'claude',
      label: 'Claude Code',
      state: 'checking',
      summary: 'Checking Claude Code',
      detail: 'Verifying runtime and authentication.',
    };
  }

  if (status.ready) {
    return {
      provider: 'claude',
      label: 'Claude Code',
      state: 'ready',
      summary: 'Ready',
      detail: status.detail || 'Claude Code can start sessions.',
    };
  }

  if (status.kind === 'install_required' || !status.runtimeInstalled) {
    return {
      provider: 'claude',
      label: 'Claude Code',
      state: 'missing',
      summary: 'Runtime missing',
      detail: status.detail || 'Claude Code was not found on this machine.',
      command: status.installCommand,
    };
  }

  if (status.kind === 'login_required') {
    return {
      provider: 'claude',
      label: 'Claude Code',
      state: 'needs_login',
      summary: 'Login required',
      detail: status.detail || 'Claude Code needs authentication.',
      command: status.loginCommand,
    };
  }

  return {
    provider: 'claude',
    label: 'Claude Code',
    state: 'error',
    summary: status.summary || 'Check failed',
    detail: status.detail || 'Aegis could not verify the Claude runtime.',
  };
}

function buildCodexEntry(
  status: CodexRuntimeStatus,
  loading: boolean
): AgentReadinessEntry {
  if (loading) {
    return {
      provider: 'codex',
      label: 'Codex CLI',
      state: 'checking',
      summary: 'Checking Codex',
      detail: 'Verifying codex-acp and model config.',
    };
  }

  if (status.ready) {
    return {
      provider: 'codex',
      label: 'Codex CLI',
      state: 'ready',
      summary: 'Ready',
      detail: 'Codex ACP can start sessions.',
    };
  }

  if (!status.cliAvailable) {
    return {
      provider: 'codex',
      label: 'Codex CLI',
      state: 'missing',
      summary: 'Runtime missing',
      detail: 'codex-acp was not found on PATH.',
    };
  }

  return {
    provider: 'codex',
    label: 'Codex CLI',
    state: 'needs_config',
    summary: 'Config required',
    detail: 'Codex needs a config file or model configuration before it can run.',
  };
}

function buildOpencodeEntry(
  status: OpenCodeRuntimeStatus,
  loading: boolean
): AgentReadinessEntry {
  if (loading) {
    return {
      provider: 'opencode',
      label: 'OpenCode',
      state: 'checking',
      summary: 'Checking OpenCode',
      detail: 'Verifying OpenCode and model config.',
    };
  }

  if (status.ready) {
    return {
      provider: 'opencode',
      label: 'OpenCode',
      state: 'ready',
      summary: 'Ready',
      detail: 'OpenCode can start sessions.',
    };
  }

  if (!status.cliAvailable) {
    return {
      provider: 'opencode',
      label: 'OpenCode',
      state: 'missing',
      summary: 'Runtime missing',
      detail: 'opencode was not found on PATH.',
    };
  }

  return {
    provider: 'opencode',
    label: 'OpenCode',
    state: 'needs_config',
    summary: 'Config required',
    detail: 'OpenCode needs a config file or model configuration before it can run.',
  };
}
