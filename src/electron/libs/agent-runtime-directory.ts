import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  AgentProvider,
  AgentRuntimeDirectoryReport,
  AgentRuntimeEntry,
  AgentRuntimeState,
} from '../../shared/types';
import { getClaudeRuntimeStatus, invalidateClaudeRuntimeCache } from './claude-runtime-status';
import { getCodexRuntimeStatus } from './codex-runtime-status';
import { getOpencodeRuntimeStatus } from './opencode-runtime-status';
import { getKimiRuntimeStatus } from './kimi-runtime-status';
import { getGrokRuntimeStatus } from './grok-runtime-status';
import { resolvePiAgentDir } from './provider/pi-sdk-loader';
import { findMachineQoderCli } from './provider/qoder-sdk-loader';

// Static per-provider metadata for the onboarding/install guidance. Install
// commands and docs are only listed where we are confident they stay correct;
// rows without one fall back to a generic "install the <cli> CLI" hint.
const PROVIDER_META: Record<
  AgentProvider,
  { title: string; installCommand: string | null; docsUrl: string | null }
> = {
  claude: {
    title: 'Claude Code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  codex: {
    title: 'Codex CLI',
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli/',
  },
  opencode: {
    title: 'OpenCode',
    installCommand: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai/docs/',
  },
  kimi: {
    title: 'Kimi',
    installCommand: null,
    docsUrl: null,
  },
  grok: {
    title: 'Grok',
    installCommand: null,
    docsUrl: null,
  },
  pi: {
    title: 'Pi',
    installCommand: null,
    docsUrl: null,
  },
  qoder: {
    title: 'Qoder',
    installCommand: null,
    docsUrl: null,
  },
};

function entry(
  provider: AgentProvider,
  state: AgentRuntimeState,
  fields: Partial<Pick<AgentRuntimeEntry, 'version' | 'summary' | 'detail' | 'loginCommand'>>
): AgentRuntimeEntry {
  const meta = PROVIDER_META[provider];
  return {
    provider,
    title: meta.title,
    state,
    version: fields.version ?? null,
    summary: fields.summary || defaultSummary(meta.title, state),
    detail: fields.detail ?? null,
    installCommand: meta.installCommand,
    loginCommand: fields.loginCommand ?? null,
    docsUrl: meta.docsUrl,
    checkedAt: Date.now(),
  };
}

function defaultSummary(title: string, state: AgentRuntimeState): string {
  switch (state) {
    case 'ready':
      return `${title} is ready.`;
    case 'login_required':
      return `${title} is installed but not signed in.`;
    case 'not_installed':
      return `${title} is not installed.`;
    default:
      return `Could not check ${title}.`;
  }
}

async function probeClaude(force: boolean): Promise<AgentRuntimeEntry> {
  if (force) {
    invalidateClaudeRuntimeCache();
  }
  const status = await getClaudeRuntimeStatus();
  const state: AgentRuntimeState =
    status.kind === 'ready'
      ? 'ready'
      : status.kind === 'login_required'
        ? 'login_required'
        : status.kind === 'install_required'
          ? 'not_installed'
          : 'error';
  return entry('claude', state, {
    version: status.cliVersion,
    summary: status.summary,
    detail: status.detail,
    loginCommand: status.loginCommand,
  });
}

async function probeCodex(): Promise<AgentRuntimeEntry> {
  const status = await getCodexRuntimeStatus();
  if (!status.cliAvailable) {
    return entry('codex', 'not_installed', {});
  }
  if (!status.ready) {
    return entry('codex', 'login_required', {
      summary: 'Codex CLI is installed but has no account configured.',
      loginCommand: 'codex login',
    });
  }
  return entry('codex', 'ready', {});
}

async function probeOpencode(): Promise<AgentRuntimeEntry> {
  const status = await getOpencodeRuntimeStatus();
  if (!status.cliAvailable) {
    return entry('opencode', 'not_installed', {});
  }
  if (!status.ready) {
    return entry('opencode', 'login_required', {
      summary: 'OpenCode is installed but has no provider configured.',
      loginCommand: 'opencode auth login',
    });
  }
  return entry('opencode', 'ready', {});
}

async function probeKimi(): Promise<AgentRuntimeEntry> {
  const status = await getKimiRuntimeStatus();
  if (!status.cliAvailable) {
    return entry('kimi', 'not_installed', {
      detail: 'Install the Kimi CLI so `kimi` is available on PATH, then re-detect.',
    });
  }
  const state: AgentRuntimeState = status.ready
    ? 'ready'
    : status.authState === 'login_required'
      ? 'login_required'
      : 'error';
  return entry('kimi', state, {
    version: status.cliVersion,
    summary: status.summary,
    detail: status.detail,
    loginCommand: status.loginCommand,
  });
}

async function probeGrok(): Promise<AgentRuntimeEntry> {
  const status = await getGrokRuntimeStatus();
  if (!status.cliAvailable) {
    return entry('grok', 'not_installed', {
      detail: 'Install the Grok CLI so `grok` is available on PATH, then re-detect.',
    });
  }
  const state: AgentRuntimeState = status.ready
    ? 'ready'
    : status.authState === 'login_required'
      ? 'login_required'
      : 'error';
  return entry('grok', state, {
    version: status.cliVersion,
    summary: status.summary,
    detail: status.detail,
    loginCommand: status.loginCommand,
  });
}

// The Pi SDK ships with Aegis, so "installed" is a given; readiness is about
// having at least one credential in the Pi agent directory.
async function probePi(): Promise<AgentRuntimeEntry> {
  try {
    const authPath = join(resolvePiAgentDir(), 'auth.json');
    if (existsSync(authPath)) {
      const parsed = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
      if (Object.keys(parsed).some((key) => key.trim().length > 0)) {
        return entry('pi', 'ready', { summary: 'Pi is ready (bundled SDK, credentials found).' });
      }
    }
    return entry('pi', 'login_required', {
      summary: 'Pi has no credentials yet.',
      detail: 'Sign in with the Pi CLI or add a provider credential to ~/.pi/agent/auth.json.',
    });
  } catch (error) {
    return entry('pi', 'error', {
      summary: 'Could not check Pi credentials.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

// Qoder readiness = machine qodercli + login state. File-existence checks
// only (probePi pattern): never accountInfo() — it spawns a CLI per call.
async function probeQoder(): Promise<AgentRuntimeEntry> {
  try {
    if (!findMachineQoderCli()) {
      return entry('qoder', 'not_installed', {
        summary: 'Qoder CLI (qodercli) was not found on this machine.',
        detail: 'Install Qoder and make sure qodercli is on the PATH (or in ~/.local/bin).',
      });
    }
    const authUserPath = join(homedir(), '.qoder', '.auth', 'user');
    if (existsSync(authUserPath)) {
      return entry('qoder', 'ready', { summary: 'Qoder is ready (qodercli found, login state present).' });
    }
    return entry('qoder', 'login_required', {
      summary: 'Qoder is installed but not signed in.',
      detail: 'Run `qodercli login`, then retry.',
      loginCommand: 'qodercli login',
    });
  } catch (error) {
    return entry('qoder', 'error', {
      summary: 'Could not check Qoder status.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAgentRuntimeDirectory(force = false): Promise<AgentRuntimeDirectoryReport> {
  const probes: Array<[AgentProvider, Promise<AgentRuntimeEntry>]> = [
    ['claude', probeClaude(force)],
    ['codex', probeCodex()],
    ['opencode', probeOpencode()],
    ['kimi', probeKimi()],
    ['grok', probeGrok()],
    ['pi', probePi()],
    ['qoder', probeQoder()],
  ];

  const entries = await Promise.all(
    probes.map(async ([provider, probe]) => {
      try {
        return await probe;
      } catch (error) {
        return entry(provider, 'error', {
          summary: defaultSummary(PROVIDER_META[provider].title, 'error'),
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );

  return {
    entries,
    readyCount: entries.filter((item) => item.state === 'ready').length,
    checkedAt: Date.now(),
  };
}
