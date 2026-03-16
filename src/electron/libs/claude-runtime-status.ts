import { execFile } from 'child_process';
import { sep } from 'path';
import type { ClaudeRuntimeSource, ClaudeRuntimeStatus } from '../../shared/types';
import { getClaudeEnv, getClaudeSettings } from './claude-settings';
import { normalizeClaudeRequestedModel } from './claude-model-selection';
import { getClaudeCodeRuntime, type ClaudeCodeRuntime } from './claude-runtime';

const INSTALL_COMMAND = 'claude install stable';
const LOGIN_COMMAND = 'claude auth login';
const SETUP_TOKEN_COMMAND = 'claude setup-token';

type ClaudeAuthStatusPayload = {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  combined: string;
  errorMessage: string | null;
};

function requiresAnthropicAuthForModel(model?: string | null): boolean {
  const normalized = normalizeClaudeRequestedModel(model);
  if (!normalized) {
    return true;
  }
  return normalized.startsWith('claude-');
}

function resolveRuntimeSource(cliPath?: string): ClaudeRuntimeSource {
  if (!cliPath) {
    return 'unknown';
  }

  if (
    cliPath.includes(`${sep}lib${sep}node_modules${sep}@anthropic-ai${sep}claude-code${sep}`) ||
    cliPath.includes(`${sep}.nvm${sep}`) ||
    cliPath.includes(`${sep}bin${sep}claude`)
  ) {
    return 'global';
  }

  if (process.resourcesPath && cliPath.startsWith(process.resourcesPath)) {
    return 'bundled';
  }

  if (cliPath.includes('app.asar.unpacked')) {
    return 'bundled';
  }

  if (cliPath.includes(`${sep}node_modules${sep}`)) {
    return 'workspace';
  }

  return 'unknown';
}

function buildClaudeRuntimeEnv(runtimeEnv: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...getClaudeEnv(),
    ...runtimeEnv,
  };

  const settings = getClaudeSettings();
  if (settings?.apiKey && !env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = settings.apiKey;
  }

  return env;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseClaudeVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  const line = trimmed.split(/\r?\n/, 1)[0]?.trim() || '';
  const match = line.match(/^([^\s]+)/);
  return match?.[1] || line || null;
}

function describeRuntimeLocation(source: ClaudeRuntimeSource): string {
  switch (source) {
    case 'global':
      return 'the global Claude Code runtime';
    case 'bundled':
      return 'the bundled Aegis runtime';
    case 'workspace':
      return 'the local workspace runtime';
    default:
      return 'the Claude runtime';
  }
}

function execClaudeRuntimeCommand(
  runtime: ClaudeCodeRuntime,
  args: string[],
  timeoutMs = 5000
): Promise<CommandResult> {
  if (!runtime.pathToClaudeCodeExecutable) {
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: '',
      combined: '',
      errorMessage: 'Claude CLI path was not found.',
    });
  }

  const commandArgs = [...runtime.executableArgs, runtime.pathToClaudeCodeExecutable, ...args];
  const env = buildClaudeRuntimeEnv(runtime.env);

  return new Promise((resolve) => {
    execFile(
      runtime.executable,
      commandArgs,
      {
        env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as { code?: number | string } | null)?.code === 'number'
            ? Number((error as { code?: number }).code)
            : error
              ? 1
              : 0;

        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        resolve({
          code,
          stdout,
          stderr,
          combined,
          errorMessage: error ? error.message : null,
        });
      }
    );
  });
}

function buildInstallRequiredStatus(
  runtime: ClaudeCodeRuntime,
  requestedModel: string | null,
  requiresAnthropicAuth: boolean
): ClaudeRuntimeStatus {
  return {
    kind: 'install_required',
    ready: false,
    runtimeInstalled: false,
    runtimeSource: resolveRuntimeSource(runtime.pathToClaudeCodeExecutable),
    requiresAnthropicAuth,
    authSatisfied: false,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || getClaudeSettings()?.apiKey),
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    cliPath: runtime.pathToClaudeCodeExecutable || null,
    cliVersion: null,
    requestedModel,
    summary: 'Claude Code runtime not found.',
    detail:
      'Aegis could not locate the Claude CLI it needs to start Claude sessions. Reinstall Aegis or install Claude Code in a terminal, then try again.',
    installCommand: INSTALL_COMMAND,
    loginCommand: LOGIN_COMMAND,
    setupTokenCommand: SETUP_TOKEN_COMMAND,
    checkedAt: Date.now(),
  };
}

export async function getClaudeRuntimeStatus(model?: string | null): Promise<ClaudeRuntimeStatus> {
  const runtime = getClaudeCodeRuntime();
  const requestedModel = normalizeClaudeRequestedModel(model) || model?.trim() || null;
  const requiresAnthropicAuth = requiresAnthropicAuthForModel(requestedModel);
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || getClaudeSettings()?.apiKey);

  if (!runtime.pathToClaudeCodeExecutable) {
    return buildInstallRequiredStatus(runtime, requestedModel, requiresAnthropicAuth);
  }

  const runtimeSource = resolveRuntimeSource(runtime.pathToClaudeCodeExecutable);
  const runtimeLabel = describeRuntimeLocation(runtimeSource);
  const [versionResult, authResult] = await Promise.all([
    execClaudeRuntimeCommand(runtime, ['--version'], 4000),
    execClaudeRuntimeCommand(runtime, ['auth', 'status'], 5000),
  ]);

  const cliVersion = parseClaudeVersion(versionResult.stdout || versionResult.combined);
  const authPayload = extractJsonObject(authResult.combined) as ClaudeAuthStatusPayload | null;
  const loggedIn = authPayload?.loggedIn === true;
  const authMethod =
    hasApiKey && !loggedIn
      ? 'api_key'
      : typeof authPayload?.authMethod === 'string' && authPayload.authMethod.trim()
        ? authPayload.authMethod.trim()
        : null;
  const apiProvider =
    typeof authPayload?.apiProvider === 'string' && authPayload.apiProvider.trim()
      ? authPayload.apiProvider.trim()
      : null;
  const authSatisfied = !requiresAnthropicAuth || loggedIn || hasApiKey;

  if (authSatisfied) {
    const detail = !requiresAnthropicAuth
      ? `Using ${requestedModel || 'a compatible provider model'} through ${runtimeLabel}. Anthropic login is not required for this model.`
      : authMethod === 'api_key'
        ? `Claude sessions can start with ${runtimeLabel} using an API key.`
        : `Claude sessions can start with ${runtimeLabel}${cliVersion ? ` (v${cliVersion})` : ''}.`;

    return {
      kind: 'ready',
      ready: true,
      runtimeInstalled: true,
      runtimeSource,
      requiresAnthropicAuth,
      authSatisfied: true,
      hasApiKey,
      loggedIn,
      authMethod,
      apiProvider,
      cliPath: runtime.pathToClaudeCodeExecutable,
      cliVersion,
      requestedModel,
      summary: 'Claude Code is ready.',
      detail,
      installCommand: INSTALL_COMMAND,
      loginCommand: LOGIN_COMMAND,
      setupTokenCommand: SETUP_TOKEN_COMMAND,
      checkedAt: Date.now(),
    };
  }

  if (authPayload || authResult.code === 0 || authResult.code === 1) {
    return {
      kind: 'login_required',
      ready: false,
      runtimeInstalled: true,
      runtimeSource,
      requiresAnthropicAuth,
      authSatisfied: false,
      hasApiKey,
      loggedIn,
      authMethod,
      apiProvider,
      cliPath: runtime.pathToClaudeCodeExecutable,
      cliVersion,
      requestedModel,
      summary: 'Claude Code needs authentication.',
      detail:
        'Sign in with Claude Code or configure ANTHROPIC_API_KEY before using Anthropic Claude models in Aegis.',
      installCommand: INSTALL_COMMAND,
      loginCommand: LOGIN_COMMAND,
      setupTokenCommand: SETUP_TOKEN_COMMAND,
      checkedAt: Date.now(),
    };
  }

  return {
    kind: 'error',
    ready: false,
    runtimeInstalled: true,
    runtimeSource,
    requiresAnthropicAuth,
    authSatisfied: false,
    hasApiKey,
    loggedIn,
    authMethod,
    apiProvider,
    cliPath: runtime.pathToClaudeCodeExecutable,
    cliVersion,
    requestedModel,
    summary: 'Claude runtime check failed.',
    detail:
      authResult.errorMessage ||
      'Aegis could not verify Claude authentication status. Run "claude auth status" in a terminal and verify the runtime is healthy.',
    installCommand: INSTALL_COMMAND,
    loginCommand: LOGIN_COMMAND,
    setupTokenCommand: SETUP_TOKEN_COMMAND,
    checkedAt: Date.now(),
  };
}

export function formatClaudeRuntimeBlockingMessage(status: ClaudeRuntimeStatus): string {
  if (status.kind === 'install_required') {
    return `${status.summary} ${status.detail} Suggested command: ${status.installCommand || INSTALL_COMMAND}`;
  }

  if (status.kind === 'login_required') {
    return `${status.summary} ${status.detail} Suggested command: ${status.loginCommand || LOGIN_COMMAND}`;
  }

  if (status.kind === 'error') {
    return `${status.summary} ${status.detail}`;
  }

  return status.summary;
}
