import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  COMPUTER_USE_READ_ONLY_TOOLS,
  COMPUTER_USE_TOOLS,
  CODEX_COMPUTER_USE_SERVER_NAME,
  NODE_REPL_SERVER_NAME,
  type ComputerUseMediaRef,
} from '../../shared/computer-use';

export type ComputerUseSpawnPolicy = 'read-only' | 'mutating';

/**
 * Computer Use click/type tools stay available in Default, Auto, and Full
 * Access. Plan mode is the only read-only exception — it is an execution
 * mode that must not operate the desktop.
 */
export function resolveComputerUseSpawnPolicy(input: {
  permissionMode?: string | null;
  executionMode?: string | null;
}): ComputerUseSpawnPolicy {
  return input.executionMode === 'plan' ? 'read-only' : 'mutating';
}

const CLIENT_RELATIVE_PATH =
  'Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';

export function resolveComputerUseClientPath(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const override = env.AEGIS_COMPUTER_USE_CLIENT_PATH?.trim();
  if (override && existsSync(override)) return override;

  const candidates = [
    join(home, '.codex', 'computer-use', CLIENT_RELATIVE_PATH),
    join(
      '/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky',
      CLIENT_RELATIVE_PATH
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveComputerUseArtifactRoot(
  userDataDir: string,
  sessionId: string
): string {
  return join(userDataDir, 'computer-use-artifacts', sessionId);
}

function escapeOverrideString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function serializeTomlArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${escapeOverrideString(value)}"`).join(', ')}]`;
}

export function buildComputerUseMcpOverrideArgs(input: {
  clientPath: string | null;
  policy: ComputerUseSpawnPolicy;
  hasNodeRepl: boolean;
}): string[] {
  const args: string[] = [];
  const push = (assignment: string) => {
    args.push('-c', assignment);
  };

  // The bundled plugin also registers `computer-use`. Keep that name disabled
  // so Aegis can own a non-colliding structured server.
  push(`mcp_servers.${CODEX_COMPUTER_USE_SERVER_NAME}.enabled=false`);

  if (input.clientPath) {
    const prefix = `mcp_servers.${AEGIS_COMPUTER_USE_SERVER_NAME}`;
    const tools =
      input.policy === 'mutating' ? COMPUTER_USE_TOOLS : COMPUTER_USE_READ_ONLY_TOOLS;
    push(`${prefix}.command="${escapeOverrideString(input.clientPath)}"`);
    push(`${prefix}.args=["mcp"]`);
    push(`${prefix}.enabled=true`);
    push(`${prefix}.startup_timeout_sec=60`);
    push(`${prefix}.tool_timeout_sec=120`);
    push(`${prefix}.default_tools_approval_mode="writes"`);
    push(`${prefix}.enabled_tools=${serializeTomlArray(tools)}`);
  }

  if (input.hasNodeRepl) {
    const prefix = `mcp_servers.${NODE_REPL_SERVER_NAME}`;
    push(`${prefix}.default_tools_approval_mode="writes"`);
    if (input.policy === 'mutating') {
      push(`${prefix}.disabled_tools=${serializeTomlArray(['js_add_node_module_dir'])}`);
    } else {
      push(`${prefix}.disabled_tools=${serializeTomlArray(['js', 'js_add_node_module_dir'])}`);
    }
  }

  return args;
}

export class ComputerUseLease {
  private owner: { threadId: string; toolUseId: string } | null = null;

  tryAcquire(threadId: string, toolUseId: string): boolean {
    if (this.owner && this.owner.threadId !== threadId) {
      return false;
    }
    this.owner = { threadId, toolUseId };
    return true;
  }

  release(threadId: string, toolUseId?: string): void {
    if (!this.owner || this.owner.threadId !== threadId) return;
    if (toolUseId && this.owner.toolUseId !== toolUseId) return;
    this.owner = null;
  }

  releaseThread(threadId: string): void {
    if (this.owner?.threadId === threadId) {
      this.owner = null;
    }
  }

  currentOwner(): { threadId: string; toolUseId: string } | null {
    return this.owner;
  }
}

export const computerUseLease = new ComputerUseLease();

function decodeDataUrl(value: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!match) return null;
  try {
    return { mimeType: match[1], bytes: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

function collectImagePayloads(value: unknown, into: Array<{ mimeType: string; bytes: Buffer }>): void {
  if (typeof value === 'string') {
    const decoded = decodeDataUrl(value);
    if (decoded) into.push(decoded);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePayloads(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.data === 'string') {
    try {
      into.push({
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : 'image/jpeg',
        bytes: Buffer.from(record.data, 'base64'),
      });
    } catch {
      // ignore malformed payloads
    }
    return;
  }
  if (record.type === 'input_image' && typeof record.image_url === 'string') {
    collectImagePayloads(record.image_url, into);
    return;
  }
  for (const nested of Object.values(record)) {
    collectImagePayloads(nested, into);
  }
}

export function persistComputerUseMedia(input: {
  userDataDir: string;
  sessionId: string;
  payload: unknown;
}): { text: string; mediaRefs: ComputerUseMediaRef[] } {
  const images: Array<{ mimeType: string; bytes: Buffer }> = [];
  collectImagePayloads(input.payload, images);
  const text = extractComputerUseText(input.payload);
  if (images.length === 0) {
    return { text, mediaRefs: [] };
  }

  const root = resolveComputerUseArtifactRoot(input.userDataDir, input.sessionId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const mediaRefs: ComputerUseMediaRef[] = [];
  const seen = new Set<string>();

  for (const image of images) {
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const extension = image.mimeType.includes('png') ? 'png' : 'jpg';
    const filePath = join(root, `${sha256}.${extension}`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, image.bytes, { mode: 0o600 });
    }
    mediaRefs.push({
      sessionId: input.sessionId,
      mimeType: image.mimeType,
      sha256,
      sizeBytes: image.bytes.length,
    });
  }

  return { text, mediaRefs };
}

function extractComputerUseText(payload: unknown): string {
  if (typeof payload === 'string') {
    if (payload.startsWith('data:image/')) return '';
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        if (item && typeof item === 'object' && 'type' in item && (item as { type?: unknown }).type === 'text') {
          return typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '';
        }
        if (typeof item === 'string' && !item.startsWith('data:image/')) return item;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string' && !record.text.startsWith('data:image/')) {
      return record.text;
    }
    if (typeof record.output === 'string' && !record.output.startsWith('data:image/')) {
      return record.output;
    }
    return '';
  }
  return '';
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export function isPathWithinRoot(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}/`) || targetPath.startsWith(`${rootPath}\\`);
}

export function resolveComputerUseArtifact(
  userDataDir: string,
  sessionId: string,
  sha256: string
): { mimeType: string; bytes: Buffer; path: string } | null {
  if (!SESSION_ID_RE.test(sessionId) || !SHA256_RE.test(sha256)) return null;
  const root = resolveComputerUseArtifactRoot(userDataDir, sessionId);
  const candidates = [join(root, `${sha256}.jpg`), join(root, `${sha256}.png`)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = realpathSync(root);
      realFile = realpathSync(candidate);
    } catch {
      return null;
    }
    if (!isPathWithinRoot(realRoot, realFile)) return null;
    const bytes = readFileSync(realFile);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sha256) return null;
    return {
      path: realFile,
      bytes,
      mimeType: candidate.endsWith('.png') ? 'image/png' : 'image/jpeg',
    };
  }
  return null;
}

export const COMPUTER_USE_DENIED_TARGET_MESSAGE =
  'Aegis blocked Computer Use from targeting the Aegis app itself.';

export const COMPUTER_USE_LEASE_MESSAGE =
  'Another Aegis thread is already using Computer Use. Stop that turn before starting another.';
