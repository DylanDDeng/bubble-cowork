import { execFile, spawn } from 'child_process';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { MimoModelConfig, MimoRuntimeStatus, ProviderSkillDescriptor } from '../../shared/types';

// The installer drops a single binary here (`mimo upgrade` replaces it in place).
export const MIMO_DEFAULT_BINARY_PATH = path.join(homedir(), '.mimocode', 'bin', 'mimo');
export const MIMO_DOCS_URL = 'https://mimo.xiaomi.com/coder';

const EXEC_TIMEOUT_MS = 5000;

function mimoDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(homedir(), '.local', 'share'), 'mimocode');
}

function mimoConfigDir(): string {
  const override = process.env.MIMOCODE_CONFIG_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(homedir(), '.config'), 'mimocode');
}

export function mimoDatabasePath(): string {
  return process.env.MIMOCODE_DB?.trim() || path.join(mimoDataDir(), 'mimocode.db');
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function globalConfigText(): string {
  const dir = mimoConfigDir();
  return ['mimocode.jsonc', 'mimocode.json', 'config.json'].map((name) => readTextFile(path.join(dir, name))).join('\n');
}

/**
 * Credentials MiMo can run on without its own account: `mimo providers login`
 * writes auth.json, XIAOMI_API_KEY / MIMO_API_KEY feed the bundled providers,
 * and a provider configured with its own apiKey works too. A miss is not
 * proof of a sign-out, so it only combines with `whoami`.
 */
export function hasMimoCredentials(): boolean {
  if (process.env.XIAOMI_API_KEY?.trim() || process.env.MIMO_API_KEY?.trim()) return true;
  const auth = readJsonFile(path.join(mimoDataDir(), 'auth.json'));
  if (auth && typeof auth === 'object' && Object.keys(auth).length > 0) return true;
  return /"apiKey"\s*:/.test(globalConfigText());
}

function isExecutableCandidate(filePath: string | undefined | null): filePath is string {
  return Boolean(filePath && filePath.trim() && existsSync(filePath));
}

function execFileText(command: string, args: string[], timeout = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, cwd: homedir(), env: buildMimoEnv(), maxBuffer: 8 * 1024 * 1024 },
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

/** stdout only: `mimo models` may log on stderr. */
function execFileStdout(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, cwd: homedir(), env: buildMimoEnv(), maxBuffer: 16 * 1024 * 1024 },
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

export async function resolveMimoBinary(): Promise<string | null> {
  const envPath = process.env.MIMO_CLI_PATH?.trim();
  if (isExecutableCandidate(envPath)) {
    return envPath;
  }
  if (isExecutableCandidate(MIMO_DEFAULT_BINARY_PATH)) {
    return MIMO_DEFAULT_BINARY_PATH;
  }
  return resolveOnPath('mimo');
}

/** ANSI colour codes from the CLI's terminal UI. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function buildMimoEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const binDir = path.dirname(MIMO_DEFAULT_BINARY_PATH);
  const parts = (env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [binDir, ...parts.filter((part) => part !== binDir)].join(path.delimiter);
  return env;
}

export function buildMimoLoginCommand(binaryPath: string | null): string {
  return `${binaryPath || 'mimo'} providers login`;
}

// ── Runtime status ─────────────────────────────────────────────────────────

const STATUS_CACHE_TTL_MS = 10_000;
let statusCache: { status: MimoRuntimeStatus; fetchedAt: number } | null = null;
let statusInflight: Promise<MimoRuntimeStatus> | null = null;

async function probeMimoAuth(binaryPath: string): Promise<MimoRuntimeStatus['authState']> {
  try {
    const output = stripAnsi(await execFileText(binaryPath, ['providers', 'whoami'], 15_000)).toLowerCase();
    if (output.includes('not logged in')) return 'login_required';
    return 'ready';
  } catch {
    return 'unknown';
  }
}

/** Shared and briefly cached: the picker, settings and every turn gate ask at once. */
export async function getMimoRuntimeStatus(): Promise<MimoRuntimeStatus> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }
  if (statusInflight) {
    return statusInflight;
  }
  statusInflight = computeMimoRuntimeStatus()
    .then((status) => {
      statusCache = { status, fetchedAt: Date.now() };
      return status;
    })
    .finally(() => {
      statusInflight = null;
    });
  return statusInflight;
}

async function computeMimoRuntimeStatus(): Promise<MimoRuntimeStatus> {
  const cliPath = await resolveMimoBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildMimoLoginCommand(null),
      summary: 'MiMo Code CLI was not found.',
      detail: `Install it from ${MIMO_DOCS_URL} or set MIMO_CLI_PATH to the mimo executable.`,
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
  // `whoami` only covers the MiMo account; API keys and third-party
  // providers work without it, so it decides only when nothing else exists.
  const authState: MimoRuntimeStatus['authState'] = !acpAvailable
    ? 'error'
    : hasMimoCredentials()
      ? 'ready'
      : await probeMimoAuth(cliPath);
  const ready = acpAvailable && authState !== 'login_required';
  const loginCommand = buildMimoLoginCommand(cliPath);

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    authState,
    loginCommand,
    summary: ready
      ? 'MiMo Code ACP is ready.'
      : authState === 'login_required'
        ? 'MiMo Code needs login.'
        : 'MiMo Code CLI is installed but `mimo acp` is unavailable.',
    detail: ready
      ? 'Aegis can start MiMo Code sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${loginCommand}, or set XIAOMI_API_KEY, to authenticate MiMo Code.`
        : 'Update the MiMo Code CLI (`mimo upgrade`) to a version that ships the acp command.',
    checkedAt,
  };
}

export function formatMimoRuntimeBlockingMessage(status: MimoRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `MiMo Code login required. Run: ${status.loginCommand || 'mimo providers login'}`;
  }
  if (!status.cliAvailable) {
    return 'MiMo Code CLI is not installed or was not found. Install MiMo Code, then restart Aegis.';
  }
  if (!status.acpAvailable) {
    return 'MiMo Code ACP is not available from the detected mimo executable.';
  }
  return status.detail || 'MiMo Code ACP is not ready.';
}

// ── Model catalog ──────────────────────────────────────────────────────────

const MODELS_TIMEOUT_MS = 30_000;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache: { config: MimoModelConfig; fetchedAt: number } | null = null;
let modelsInflight: Promise<MimoModelConfig> | null = null;

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const MODEL_HEADER = /^(\S+\/\S+)\s+—/;

/**
 * Parses `mimo models --verbose`: each model is a `provider/model — window …`
 * line followed by its JSON metadata. Reasoning levels are the model's
 * `variants` keys, which MiMo's ACP model select addresses as
 * `provider/model/variant`.
 */
export function parseMimoModelList(raw: string): MimoModelConfig['availableModels'] {
  const models: MimoModelConfig['availableModels'] = [];
  const blocks: Array<{ id: string; json: string[] }> = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const header = MODEL_HEADER.exec(line);
    if (header) {
      blocks.push({ id: header[1], json: [] });
      continue;
    }
    blocks[blocks.length - 1]?.json.push(line);
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    let meta: Record<string, unknown> | null = null;
    try {
      meta = getRecord(JSON.parse(block.json.join('\n')));
    } catch {
      meta = null;
    }
    const name = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : block.id;
    const contextWindow = getRecord(meta?.limit)?.context;
    models.push({
      id: block.id,
      label: name,
      reasoningEfforts: Object.keys(getRecord(meta?.variants) || {}),
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  // The same display name under two providers needs the provider to tell apart.
  const counts = new Map<string, number>();
  for (const model of models) counts.set(model.label, (counts.get(model.label) || 0) + 1);
  return models.map((model) =>
    (counts.get(model.label) || 0) > 1 ? { ...model, label: `${model.label} (${model.id.split('/')[0]})` } : model
  );
}

/** Top-level `model` from the global config: what a fresh MiMo session starts on. */
function readConfiguredDefaultModel(): string | null {
  const text = globalConfigText();
  const match = /^\s*"model"\s*:\s*"([^"]+)"/m.exec(text);
  return match?.[1]?.trim() || null;
}

async function fetchMimoModelConfig(): Promise<MimoModelConfig> {
  const empty: MimoModelConfig = { defaultModel: null, options: [], availableModels: [] };
  const binary = await resolveMimoBinary();
  if (!binary) return empty;
  try {
    const availableModels = parseMimoModelList(await execFileStdout(binary, ['models', '--verbose'], MODELS_TIMEOUT_MS));
    const configured = readConfiguredDefaultModel();
    return {
      defaultModel: configured && availableModels.some((model) => model.id === configured) ? configured : null,
      options: availableModels.map((model) => model.id),
      availableModels,
    };
  } catch (error) {
    console.warn('[MiMo] failed to read the model catalog:', error instanceof Error ? error.message : error);
    return empty;
  }
}

/** Cached: listing models boots the CLI. A failed (empty) read is never cached. */
export async function getMimoModelConfig(): Promise<MimoModelConfig> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.config;
  }
  if (modelsInflight) {
    return modelsInflight;
  }
  modelsInflight = fetchMimoModelConfig()
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

// ── Turn errors ────────────────────────────────────────────────────────────

/**
 * MiMo's ACP agent ends a turn whose model call failed (bad key, quota, the
 * provider's content filter) with a plain end_turn and no error
 * notification; the error is only stored on the assistant message. Reads the newest assistant
 * message of the session and returns its error text, if any.
 */
export function readMimoLastTurnError(sessionId: string, since: number): string | null {
  const dbPath = mimoDatabasePath();
  if (!sessionId || !existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT data FROM message
         WHERE session_id = ? AND time_created >= ? AND json_extract(data, '$.role') = 'assistant'
         ORDER BY time_created DESC LIMIT 1`
      )
      .get(sessionId, since) as { data?: string } | undefined;
    const error = getRecord(getRecord(row?.data ? JSON.parse(row.data) : null)?.error);
    if (!error) return null;
    const data = getRecord(error.data);
    const message = typeof data?.message === 'string' ? data.message.trim() : '';
    const name = typeof error.name === 'string' ? error.name : '';
    return message || name || null;
  } catch (error) {
    console.warn('[MiMo] could not read the turn error:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    db?.close();
  }
}

export interface MimoTurnUsage {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * Token usage of a whole turn. MiMo stores every model step as its own
 * assistant message, while ACP's prompt response carries only the last
 * step's tokens; summing the turn's messages gives the real totals. Returns
 * null when nothing was recorded (or the DB is unreadable).
 */
export function readMimoTurnUsage(sessionId: string, since: number): MimoTurnUsage | null {
  const dbPath = mimoDatabasePath();
  if (!sessionId || !existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS steps,
           COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS input,
           COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS output,
           COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
           COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS cacheRead,
           COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cacheWrite,
           COALESCE(SUM(json_extract(data, '$.cost')), 0) AS cost
         FROM message
         WHERE session_id = ? AND time_created >= ? AND json_extract(data, '$.role') = 'assistant'`
      )
      .get(sessionId, since) as Record<string, number> | undefined;
    if (!row || !row.steps) return null;
    return {
      steps: row.steps,
      inputTokens: row.input,
      outputTokens: row.output,
      reasoningTokens: row.reasoning,
      cacheReadTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
      costUsd: row.cost,
    };
  } catch (error) {
    console.warn('[MiMo] could not read the turn usage:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    db?.close();
  }
}

// ── Skills ─────────────────────────────────────────────────────────────────

const SKILLS_SERVER_TIMEOUT_MS = 20_000;

function isWithin(child: string, parent: string | undefined): boolean {
  if (!parent) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Maps MiMo's `GET /skill` listing: its own resolved catalog across the
 * builtin and compose roots it unpacks under its data dir, the user roots it
 * imports (~/.agents, ~/.codex, ~/.claude, its own) and the project's. The
 * body comes inline, so builtins need no file read.
 */
export function parseMimoSkillList(raw: unknown, cwd?: string): ProviderSkillDescriptor[] {
  const dataDir = mimoDataDir();
  const skills: ProviderSkillDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = getRecord(entry);
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const location = typeof record?.location === 'string' ? record.location.trim() : '';
    const description = typeof record?.description === 'string' ? record.description.trim() : '';
    const builtin = record?.bundled === true || (Boolean(location) && isWithin(location, dataDir));
    skills.push({
      name,
      path: location || `mimo-builtin:${name}`,
      enabled: true,
      ...(description ? { description } : {}),
      // SkillListPane sections: Personal / Project / System.
      scope: builtin ? 'system' : location && isWithin(location, cwd) ? 'project' : 'user',
      content: typeof record?.content === 'string' ? record.content : null,
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * MiMo has no `skills` command; its headless server answers `GET /skill`
 * with the resolved list. A short-lived loopback server is started for the
 * read and stopped right after.
 */
export async function listMimoSkills(cwd?: string): Promise<ProviderSkillDescriptor[]> {
  const binary = await resolveMimoBinary();
  if (!binary) {
    throw new Error('MiMo Code CLI was not found. Install MiMo Code or set MIMO_CLI_PATH.');
  }
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir();
  const proc = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workingDir,
    env: buildMimoEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('MiMo server did not start in time.')), SKILLS_SERVER_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = /listening on (https?:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`MiMo server exited (${code}) before listening.`));
      });
    });
    const response = await fetch(`${baseUrl}/skill?directory=${encodeURIComponent(workingDir)}`, {
      signal: AbortSignal.timeout(SKILLS_SERVER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`MiMo skill listing failed (${response.status}).`);
    }
    return parseMimoSkillList(await response.json(), cwd);
  } finally {
    proc.kill('SIGTERM');
  }
}
