import { execFile } from 'child_process';
import type { ClaudeRuntimeSource, ClaudeRuntimeStatus } from '../../shared/types';
import {
  createClaudeRuntimeStatusCache,
  deriveClaudeRuntimeStatus,
  type ClaudeRuntimeProbe,
} from './claude-runtime-verdict';

export {
  createClaudeRuntimeStatusCache,
  deriveClaudeRuntimeStatus,
  formatClaudeRuntimeBlockingMessage,
  type ClaudeRuntimeProbe,
  type ClaudeRuntimeStatusCache,
} from './claude-runtime-verdict';
import { getClaudeEnv, hasClaudeCodeOAuthAccount, sanitizeOfficialClaudeEnv } from './claude-settings';
import {
  getClaudeCodeRuntime,
  isClaudeCodeNativeExecutable,
  type ClaudeCodeRuntime,
} from './claude-runtime';

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

function resolveRuntimeSource(cliPath?: string | null): ClaudeRuntimeSource {
  if (!cliPath) {
    return 'unknown';
  }
  return 'global';
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

function execClaudeRuntimeCommand(
  runtime: ClaudeCodeRuntime,
  args: string[],
  timeoutMs = 5000,
  env?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  if (!runtime.executable) {
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: '',
      combined: '',
      errorMessage: 'Claude CLI path was not found.',
    });
  }

  const nativeExecutable = isClaudeCodeNativeExecutable(runtime.pathToClaudeCodeExecutable)
    ? runtime.pathToClaudeCodeExecutable
    : undefined;
  const command = nativeExecutable || runtime.executable;
  const commandArgs = nativeExecutable
    ? args
    : runtime.pathToClaudeCodeExecutable
      ? [...runtime.executableArgs, runtime.pathToClaudeCodeExecutable, ...args]
      : [...runtime.executableArgs, ...args];
  const commandEnv = env || { ...process.env, ...getClaudeEnv(), ...runtime.env };

  return new Promise((resolve) => {
    execFile(
      command,
      commandArgs,
      {
        env: commandEnv,
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

/**
 * Run the expensive, model-independent runtime probe: locate the CLI and ask
 * it for version + auth state. The auth subprocess runs under the sanitized
 * official env — auth only gates official Anthropic models, and those always
 * use the sanitized env at runtime. Env-derived facts are captured for both
 * env variants so `deriveClaudeRuntimeStatus` can stay a pure function.
 */
export async function probeClaudeRuntime(): Promise<ClaudeRuntimeProbe> {
  const runtime = getClaudeCodeRuntime();
  const hasClaudeCodeAccount = hasClaudeCodeOAuthAccount();
  const rawEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...getClaudeEnv(),
    ...runtime.env,
  };
  const sanitizedEnv = sanitizeOfficialClaudeEnv(rawEnv);
  const runtimePath = runtime.pathToClaudeCodeExecutable || runtime.executable || null;
  const checkedAt = Date.now();

  if (!runtimePath) {
    return {
      runtimePath: null,
      runtimeSource: 'unknown',
      cliVersion: null,
      loggedIn: false,
      payloadAuthMethod: null,
      apiProvider: null,
      hasApiKeySanitized: Boolean(sanitizedEnv.ANTHROPIC_API_KEY),
      hasApiKeyUnsanitized: Boolean(rawEnv.ANTHROPIC_API_KEY),
      hasClaudeCodeAccount,
      authProbeResponsive: false,
      authProbeErrorMessage: null,
      checkedAt,
    };
  }

  const [versionResult, authResult] = await Promise.all([
    execClaudeRuntimeCommand(runtime, ['--version'], 4000, sanitizedEnv),
    execClaudeRuntimeCommand(runtime, ['auth', 'status'], 5000, sanitizedEnv),
  ]);

  const cliVersion = parseClaudeVersion(versionResult.stdout || versionResult.combined);
  const authPayload = extractJsonObject(authResult.combined) as ClaudeAuthStatusPayload | null;

  return {
    runtimePath,
    runtimeSource: resolveRuntimeSource(runtimePath),
    cliVersion,
    loggedIn: authPayload?.loggedIn === true || hasClaudeCodeAccount,
    payloadAuthMethod:
      typeof authPayload?.authMethod === 'string' && authPayload.authMethod.trim()
        ? authPayload.authMethod.trim()
        : null,
    apiProvider:
      typeof authPayload?.apiProvider === 'string' && authPayload.apiProvider.trim()
        ? authPayload.apiProvider.trim()
        : null,
    hasApiKeySanitized: Boolean(sanitizedEnv.ANTHROPIC_API_KEY),
    hasApiKeyUnsanitized: Boolean(rawEnv.ANTHROPIC_API_KEY),
    hasClaudeCodeAccount,
    authProbeResponsive: Boolean(authPayload) || authResult.code === 0 || authResult.code === 1,
    authProbeErrorMessage: authResult.errorMessage,
    checkedAt,
  };
}

export async function getClaudeRuntimeStatus(model?: string | null): Promise<ClaudeRuntimeStatus> {
  return deriveClaudeRuntimeStatus(await probeClaudeRuntime(), model ?? null);
}

const defaultCache = createClaudeRuntimeStatusCache({ probe: probeClaudeRuntime });

/**
 * 清除缓存。当用户修改 Claude 设置（CLI 路径、模型、API Key 等）时调用。
 */
export function invalidateClaudeRuntimeCache(): void {
  defaultCache.invalidate();
}

/**
 * 获取 Claude 运行时状态（带缓存）。探测结果与模型无关，按模型的裁决为纯同步
 * 计算；稳态下每次发送的检查成本约为 0ms。
 */
export function getClaudeRuntimeStatusCached(model?: string | null): Promise<ClaudeRuntimeStatus> {
  return defaultCache.get(model);
}

/**
 * 后台预热缓存。在 App 启动时调用，不阻塞启动流程。
 * 如果检查失败，会在下次 getClaudeRuntimeStatusCached 调用时重试。
 */
export async function prefetchClaudeRuntimeStatus(): Promise<void> {
  await defaultCache.prefetch();
}
