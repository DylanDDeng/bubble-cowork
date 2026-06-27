import { useMemo } from 'react';
import type {
  AgentProvider,
  ClaudeRuntimeStatus,
  CodexRuntimeStatus,
  KimiRuntimeStatus,
  GrokRuntimeStatus,
  OpenCodeRuntimeStatus,
} from '../types';
import { useClaudeRuntimeStatus } from './useClaudeRuntimeStatus';
import { useCodexRuntimeStatus } from './useCodexRuntimeStatus';
import { useKimiRuntimeStatus } from './useKimiRuntimeStatus';
import { useGrokRuntimeStatus } from './useGrokRuntimeStatus';
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
  const {
    status: kimiStatus,
    loading: kimiLoading,
    refresh: refreshKimi,
  } = useKimiRuntimeStatus(enabled);
  const {
    status: grokStatus,
    loading: grokLoading,
    refresh: refreshGrok,
  } = useGrokRuntimeStatus(enabled);

  const claudeChecking = enabled && (claudeLoading || claudeStatus.checkedAt === 0);
  const codexChecking = enabled && (codexLoading || codexStatus.checkedAt === 0);
  const opencodeChecking = enabled && (opencodeLoading || opencodeStatus.checkedAt === 0);
  const kimiChecking = enabled && (kimiLoading || kimiStatus.checkedAt === 0);
  const grokChecking = enabled && (grokLoading || grokStatus.checkedAt === 0);

  const entries = useMemo(
    () => [
      buildClaudeEntry(claudeStatus, claudeChecking),
      buildCodexEntry(codexStatus, codexChecking),
      buildOpencodeEntry(opencodeStatus, opencodeChecking),
      buildKimiEntry(kimiStatus, kimiChecking),
      buildGrokEntry(grokStatus, grokChecking),
    ],
    [
      claudeChecking,
      claudeStatus,
      codexChecking,
      codexStatus,
      opencodeChecking,
      opencodeStatus,
      kimiChecking,
      kimiStatus,
      grokChecking,
      grokStatus,
    ]
  );

  return {
    entries,
    readyCount: entries.filter((entry) => entry.state === 'ready').length,
    setupCount: entries.filter((entry) => entry.state !== 'ready' && entry.state !== 'checking').length,
    loading: claudeChecking || codexChecking || opencodeChecking || kimiChecking || grokChecking,
    refresh: () => {
      refreshClaude();
      refreshCodex();
      refreshOpencode();
      refreshKimi();
      refreshGrok();
    },
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
      detail: 'Verifying Codex app-server and model config.',
    };
  }

  if (status.ready) {
    return {
      provider: 'codex',
      label: 'Codex CLI',
      state: 'ready',
      summary: 'Ready',
      detail: 'Codex app-server can start sessions.',
    };
  }

  if (!status.cliAvailable) {
    return {
      provider: 'codex',
      label: 'Codex CLI',
      state: 'missing',
      summary: 'Runtime missing',
      detail: 'Codex CLI with app-server support was not found on PATH.',
      command: 'npm install -g @openai/codex',
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
      command: 'npm install -g opencode-ai',
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

function buildKimiEntry(
  status: KimiRuntimeStatus,
  loading: boolean
): AgentReadinessEntry {
  if (loading) {
    return {
      provider: 'kimi',
      label: 'Kimi Code',
      state: 'checking',
      summary: 'Checking Kimi Code',
      detail: 'Verifying Kimi Code ACP and authentication.',
    };
  }

  if (status.ready) {
    return {
      provider: 'kimi',
      label: 'Kimi Code',
      state: 'ready',
      summary: 'Ready',
      detail: status.detail || 'Kimi Code can start ACP sessions.',
    };
  }

  if (!status.cliAvailable) {
    return {
      provider: 'kimi',
      label: 'Kimi Code',
      state: 'missing',
      summary: 'Runtime missing',
      detail: status.detail || 'Kimi Code was not found on this machine.',
      command: 'Install Kimi Code',
    };
  }

  if (status.authState === 'login_required') {
    return {
      provider: 'kimi',
      label: 'Kimi Code',
      state: 'needs_login',
      summary: 'Login required',
      detail: status.detail || 'Kimi Code needs authentication.',
      command: status.loginCommand,
    };
  }

  return {
    provider: 'kimi',
    label: 'Kimi Code',
    state: 'error',
    summary: status.summary || 'Check failed',
    detail: status.detail || 'Aegis could not verify the Kimi Code runtime.',
  };
}

function buildGrokEntry(
  status: GrokRuntimeStatus,
  loading: boolean
): AgentReadinessEntry {
  if (loading) {
    return {
      provider: 'grok',
      label: 'Grok Build',
      state: 'checking',
      summary: 'Checking Grok Build',
      detail: 'Verifying Grok Build ACP and authentication.',
    };
  }

  if (status.ready) {
    return {
      provider: 'grok',
      label: 'Grok Build',
      state: 'ready',
      summary: 'Ready',
      detail: status.detail || 'Grok Build can start ACP sessions.',
    };
  }

  if (!status.cliAvailable) {
    return {
      provider: 'grok',
      label: 'Grok Build',
      state: 'missing',
      summary: 'Runtime missing',
      detail: status.detail || 'Grok Build was not found on this machine.',
      command: 'Install Grok Build',
    };
  }

  if (status.authState === 'login_required') {
    return {
      provider: 'grok',
      label: 'Grok Build',
      state: 'needs_login',
      summary: 'Login required',
      detail: status.detail || 'Grok Build needs authentication.',
      command: status.loginCommand,
    };
  }

  return {
    provider: 'grok',
    label: 'Grok Build',
    state: 'error',
    summary: status.summary || 'Check failed',
    detail: status.detail || 'Aegis could not verify the Grok Build runtime.',
  };
}
