import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import type { DevinModelConfig, DevinRuntimeStatus, DevinThoughtLevels, ProviderSkillDescriptor } from '../../shared/types';
import { AcpJsonRpcClient } from './provider/acp-json-rpc-client';

// The installer symlinks the CLI here (→ ~/.local/share/devin/cli/_versions/current).
export const DEVIN_DEFAULT_BINARY_PATH = path.join(homedir(), '.local', 'bin', 'devin');
export const DEVIN_INSTALL_COMMAND = 'curl -fsSL https://cli.devin.ai/install.sh | bash';
export const DEVIN_DOCS_URL = 'https://docs.devin.ai/cli';

const EXEC_TIMEOUT_MS = 5000;

function devinDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(homedir(), '.local', 'share'), 'devin');
}

/**
 * Cheap "probably signed in" hint: `devin auth login` writes
 * credentials.toml, and `devin acp` also accepts WINDSURF_API_KEY. A miss
 * falls through to `devin auth status`, so a storage change costs one extra
 * spawn rather than a wrong answer.
 */
export function hasDevinStoredCredentials(): boolean {
  return Boolean(process.env.WINDSURF_API_KEY?.trim()) || existsSync(path.join(devinDataDir(), 'credentials.toml'));
}

function isExecutableCandidate(filePath: string | undefined | null): filePath is string {
  return Boolean(filePath && filePath.trim() && existsSync(filePath));
}

function execFileText(command: string, args: string[], timeout = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, env: buildDevinEnv(), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { output: `${stdout || ''}${stderr || ''}` }));
          return;
        }
        resolve(`${stdout || ''}${stderr || ''}`.trim());
      }
    );
  });
}

/** stdout only: CLI commands with machine-readable output may warn on stderr. */
function execFileStdout(command: string, args: string[], timeout: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, cwd, env: buildDevinEnv(), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

async function resolveOnPath(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = await execFileText(locator, [command], 2500);
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

export async function resolveDevinBinary(): Promise<string | null> {
  const envPath = process.env.DEVIN_CLI_PATH?.trim();
  if (isExecutableCandidate(envPath)) {
    return envPath;
  }
  if (isExecutableCandidate(DEVIN_DEFAULT_BINARY_PATH)) {
    return DEVIN_DEFAULT_BINARY_PATH;
  }
  return resolveOnPath('devin');
}

export function buildDevinEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binDir = path.dirname(DEVIN_DEFAULT_BINARY_PATH);
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [binDir, ...parts.filter((part) => part !== binDir)].join(path.delimiter);
  return env;
}

export function buildDevinLoginCommand(binaryPath: string | null): string {
  return `${binaryPath || 'devin'} auth login`;
}

// ── Runtime status ─────────────────────────────────────────────────────────

const STATUS_CACHE_TTL_MS = 10_000;
let statusCache: { status: DevinRuntimeStatus; fetchedAt: number } | null = null;
let statusInflight: Promise<DevinRuntimeStatus> | null = null;

async function probeDevinAuth(binaryPath: string): Promise<DevinRuntimeStatus['authState']> {
  try {
    const output = (await execFileText(binaryPath, ['auth', 'status'])).toLowerCase();
    if (output.includes('not logged in') || output.includes('logged out')) return 'login_required';
    return output.includes('logged in') ? 'ready' : 'unknown';
  } catch (error) {
    const output = String((error as { output?: unknown }).output || '').toLowerCase();
    return output.includes('not logged in') ? 'login_required' : 'unknown';
  }
}

/** Shared and briefly cached: the picker, settings and every turn gate ask at once. */
export async function getDevinRuntimeStatus(): Promise<DevinRuntimeStatus> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }
  if (statusInflight) {
    return statusInflight;
  }
  statusInflight = computeDevinRuntimeStatus()
    .then((status) => {
      statusCache = { status, fetchedAt: Date.now() };
      return status;
    })
    .finally(() => {
      statusInflight = null;
    });
  return statusInflight;
}

async function computeDevinRuntimeStatus(): Promise<DevinRuntimeStatus> {
  const cliPath = await resolveDevinBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildDevinLoginCommand(null),
      summary: 'Devin CLI was not found.',
      detail: `Install it with \`${DEVIN_INSTALL_COMMAND}\` or set DEVIN_CLI_PATH to the devin executable.`,
      checkedAt,
    };
  }

  const [cliVersion, acpAvailable] = await Promise.all([
    execFileText(cliPath, ['--version'])
      .then((output) => output.match(/\d+\.\d+\.\d+/)?.[0] || output || null)
      .catch(() => null),
    execFileText(cliPath, ['acp', '--help'])
      .then((output) => output.includes('ACP') || output.includes('Agent Client Protocol'))
      .catch(() => false),
  ]);
  const authState: DevinRuntimeStatus['authState'] = !acpAvailable
    ? 'error'
    : hasDevinStoredCredentials()
      ? 'ready'
      : await probeDevinAuth(cliPath);
  // Only a definitive sign-out blocks the provider; an inconclusive probe
  // leaves it usable and lets the real failure surface at turn time.
  const ready = acpAvailable && authState !== 'login_required';
  const loginCommand = buildDevinLoginCommand(cliPath);

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    authState,
    loginCommand,
    summary: ready
      ? 'Devin ACP is ready.'
      : authState === 'login_required'
        ? 'Devin needs login.'
        : 'Devin CLI is installed but `devin acp` is unavailable.',
    detail: ready
      ? 'Aegis can start Devin sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${loginCommand} to authenticate Devin.`
        : 'Update the Devin CLI (`devin update`) to a version that ships the acp command.',
    checkedAt,
  };
}

export function formatDevinRuntimeBlockingMessage(status: DevinRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `Devin login required. Run: ${status.loginCommand || 'devin auth login'}`;
  }
  if (!status.cliAvailable) {
    return 'Devin CLI is not installed or was not found. Install the Devin CLI, then restart Aegis.';
  }
  if (!status.acpAvailable) {
    return 'Devin ACP is not available from the detected devin executable.';
  }
  return status.detail || 'Devin ACP is not ready.';
}

// ── Model catalog ──────────────────────────────────────────────────────────

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache: { config: DevinModelConfig; fetchedAt: number } | null = null;
let modelsInflight: Promise<DevinModelConfig> | null = null;

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The `model` select of an ACP session's configOptions. Options may be flat
 * ({ value, name }) or grouped ({ name, options: [...] }); Devin has served
 * both shapes (per-variant ids, and per-family ids with a separate
 * `thought_level` option), so read whichever arrives.
 */
export function parseDevinAcpModelOptions(configOptions: unknown): Pick<DevinModelConfig, 'defaultModel' | 'availableModels'> {
  const modelOption = (Array.isArray(configOptions) ? configOptions : [])
    .map(getRecord)
    .find((option) => option?.id === 'model' || option?.category === 'model');
  const availableModels: DevinModelConfig['availableModels'] = [];
  const seen = new Set<string>();
  const visit = (entries: unknown): void => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const record = getRecord(entry);
      if (!record) continue;
      if (Array.isArray(record.options)) {
        visit(record.options);
        continue;
      }
      const id = typeof record.value === 'string' ? record.value.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : id;
      availableModels.push({ id, label });
    }
  };
  visit(modelOption?.options);
  const current = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue.trim() : '';
  return { defaultModel: current || null, availableModels };
}

/**
 * The `thought_level` select of an ACP session's configOptions. Levels (and
 * whether there are any) differ per model and the select resets to the
 * model's own default on every model switch, so it is read per model.
 */
export function parseDevinThoughtLevels(configOptions: unknown): Pick<DevinThoughtLevels, 'levels' | 'defaultLevel'> {
  const option = (Array.isArray(configOptions) ? configOptions : [])
    .map(getRecord)
    .find((entry) => entry?.id === 'thought_level' || entry?.category === 'thought_level');
  const levels: DevinThoughtLevels['levels'] = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    const record = getRecord(entry);
    const id = typeof record?.value === 'string' ? record.value.trim() : '';
    if (!id || levels.some((level) => level.id === id)) continue;
    const label = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : id;
    levels.push({ id, label });
  }
  const current = typeof option?.currentValue === 'string' ? option.currentValue.trim() : '';
  return { levels, defaultLevel: levels.some((level) => level.id === current) ? current : null };
}

const PROBE_OPERATION_TIMEOUT_MS = 30_000;
const PROBE_IDLE_MS = 45_000;

interface ProbeHandle {
  rpc: AcpJsonRpcClient;
  sessionId: string;
  /** configOptions of the fresh session: the account's default model + its levels. */
  initialConfig: unknown;
}

/**
 * `devin models list` names per-variant ids that the ACP session may reject
 * (`Invalid value ... for config option 'model'`), so the catalog and the
 * per-model thinking levels come from an ACP session itself: a throwaway
 * session in an empty directory, kept briefly for follow-up reads (each
 * model's levels cost one set_config_option round trip), then deleted so it
 * never shows up in `devin list`.
 */
class DevinProbeSession {
  private handle: Promise<ProbeHandle> | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  run<T>(operation: (probe: ProbeHandle) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => operation(await this.open()))(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Devin ACP probe timed out.')), PROBE_OPERATION_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        this.close();
        throw error;
      } finally {
        clearTimeout(timer);
        this.idleTimer = setTimeout(() => this.close(), PROBE_IDLE_MS);
        this.idleTimer.unref?.();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private open(): Promise<ProbeHandle> {
    this.handle ??= (async () => {
      const binary = await resolveDevinBinary();
      if (!binary) throw new Error('Devin CLI was not found.');
      const cwd = path.join(tmpdir(), 'aegis-devin-model-probe');
      mkdirSync(cwd, { recursive: true });
      const proc = spawn(binary, ['acp'], { cwd, env: buildDevinEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stderr.resume();
      proc.once('exit', () => {
        if (this.proc === proc) {
          this.proc = null;
          this.handle = null;
        }
      });
      const rpc = new AcpJsonRpcClient(
        proc,
        () => {},
        (request) => rpc.respond(request.id, undefined, { code: -32601, message: 'Aegis model probe does not service requests.' }),
        () => {}
      );
      await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' }, clientCapabilities: {} });
      const session = getRecord(await rpc.request('session/new', { cwd, mcpServers: [] }));
      const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : '';
      if (!sessionId) throw new Error('Devin ACP did not return a sessionId.');
      return { rpc, sessionId, initialConfig: session?.configOptions };
    })();
    return this.handle;
  }

  private close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const proc = this.proc;
    const handle = this.handle;
    this.proc = null;
    this.handle = null;
    if (!proc) return;
    void (handle ?? Promise.reject(new Error('no probe')))
      .then(({ rpc, sessionId }) =>
        Promise.race([
          rpc.request('session/delete', { sessionId }),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ])
      )
      .catch(() => undefined)
      .finally(() => proc.kill('SIGTERM'));
  }
}

const probeSession = new DevinProbeSession();

async function fetchDevinModelConfig(): Promise<DevinModelConfig> {
  const empty: DevinModelConfig = { defaultModel: null, options: [], availableModels: [] };
  try {
    return await probeSession.run(async ({ initialConfig }) => {
      const parsed = parseDevinAcpModelOptions(initialConfig);
      if (parsed.defaultModel) {
        thoughtLevelsCache.set(parsed.defaultModel, { ...parseDevinThoughtLevels(initialConfig), fetchedAt: Date.now() });
      }
      return { ...parsed, options: parsed.availableModels.map((model) => model.id) };
    });
  } catch (error) {
    console.warn('[Devin] failed to read the model catalog:', error instanceof Error ? error.message : error);
    return empty;
  }
}

const thoughtLevelsCache = new Map<string, Pick<DevinThoughtLevels, 'levels' | 'defaultLevel'> & { fetchedAt: number }>();

/**
 * Thinking levels for one model (null/'' = the account default model). An
 * empty list means the model has no thinking control.
 */
export async function getDevinThoughtLevels(model: string | null | undefined): Promise<DevinThoughtLevels> {
  const config = await getDevinModelConfig();
  const resolved = model?.trim() || config.defaultModel;
  if (!resolved) return { model: null, levels: [], defaultLevel: null };
  const cached = thoughtLevelsCache.get(resolved);
  if (cached && Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS) {
    return { model: resolved, levels: cached.levels, defaultLevel: cached.defaultLevel };
  }
  try {
    const parsed = await probeSession.run(async ({ rpc, sessionId }) =>
      parseDevinThoughtLevels(
        getRecord(await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: resolved }))
          ?.configOptions
      )
    );
    thoughtLevelsCache.set(resolved, { ...parsed, fetchedAt: Date.now() });
    return { model: resolved, ...parsed };
  } catch (error) {
    console.warn('[Devin] failed to read thinking levels:', error instanceof Error ? error.message : error);
    return { model: resolved, levels: [], defaultLevel: null };
  }
}

/**
 * The catalog is per-account and changes rarely, but reading it boots an ACP
 * agent — cache it, and never cache an empty (failed) read.
 */
export async function getDevinModelConfig(): Promise<DevinModelConfig> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.config;
  }
  if (modelsInflight) {
    return modelsInflight;
  }
  modelsInflight = fetchDevinModelConfig()
    .then((config) => {
      if (config.availableModels.length > 0) {
        modelsCache = { config, fetchedAt: Date.now() };
      }
      return config;
    })
    .finally(() => {
      modelsInflight = null;
    });
  return modelsInflight;
}

// ── Skills ─────────────────────────────────────────────────────────────────

const SKILLS_TIMEOUT_MS = 20_000;

interface DevinSkillListing {
  descriptor: ProviderSkillDescriptor;
  /** No SKILL.md on disk (builtins ship inside the CLI): read via `skills show`. */
  needsInlineContent: boolean;
}

function isWithin(child: string, parent: string | undefined): boolean {
  if (!parent) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Parses `devin skills list --json`: Devin's own resolved catalog across its
 * user, project and imported (~/.claude/skills) roots plus builtins. `name`
 * is what follows `/` in the composer (Devin prefixes duplicates, e.g.
 * `agents:article-score`).
 */
export function parseDevinSkillList(raw: string, cwd?: string): DevinSkillListing[] {
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [];
  const listings: DevinSkillListing[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = getRecord(entry);
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const baseDir = typeof record?.base_dir === 'string' ? record.base_dir.trim() : '';
    const skillFile = baseDir ? path.join(baseDir, 'SKILL.md') : '';
    const hasFile = Boolean(skillFile) && existsSync(skillFile);
    const builtin = record?.provider === 'Builtin';
    const description = typeof record?.description === 'string' ? record.description.trim() : '';
    listings.push({
      descriptor: {
        name,
        path: hasFile ? skillFile : `devin-builtin:${name}`,
        enabled: true,
        ...(description ? { description } : {}),
        // SkillListPane sections: Personal / Project / System.
        scope: builtin ? 'system' : isWithin(baseDir, cwd) ? 'project' : 'user',
      },
      needsInlineContent: !hasFile,
    });
  }
  return listings.sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name));
}

/**
 * The body `devin skills show` prints after its `Content:` line and rule.
 * Anchored to a line of its own: a description may contain "Content:".
 */
export function parseDevinSkillShowContent(raw: string): string | null {
  const match = /^Content:[ \t]*\r?\n(?:[ \t]*[─━-]{3,}[ \t]*\r?\n)?/m.exec(raw);
  if (!match) return null;
  return raw.slice(match.index + match[0].length).trim() || null;
}

export async function listDevinSkills(cwd?: string): Promise<ProviderSkillDescriptor[]> {
  const binary = await resolveDevinBinary();
  if (!binary) {
    throw new Error('Devin CLI was not found. Install the Devin CLI or set DEVIN_CLI_PATH.');
  }
  const workingDir = cwd && existsSync(cwd) ? cwd : undefined;
  const listings = parseDevinSkillList(
    await execFileStdout(binary, ['skills', 'list', '--json'], SKILLS_TIMEOUT_MS, workingDir),
    workingDir
  );
  await Promise.all(
    listings
      .filter((listing) => listing.needsInlineContent)
      .map(async (listing) => {
        try {
          const shown = await execFileStdout(binary, ['skills', 'show', listing.descriptor.name], SKILLS_TIMEOUT_MS, workingDir);
          listing.descriptor.content = parseDevinSkillShowContent(shown);
        } catch {
          listing.descriptor.content = null;
        }
      })
  );
  return listings.map((listing) => listing.descriptor);
}
