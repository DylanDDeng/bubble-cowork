import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, watch, type FSWatcher, promises as fsPromises } from 'fs';
import { execFile } from 'child_process';
import type { AddressInfo } from 'net';
import { promisify } from 'util';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { basename, dirname, extname, resolve, relative, isAbsolute, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as sessions from './libs/session-store';
import { runCodexOneShot, runOpenCodeOneShot } from './libs/codex-runner';
import {
  forkClaudeAgentSession,
  generateSessionTitle,
  generateWorktreeBranchSlug,
  runClaudeOneShot,
} from './libs/util';
import { ensureProviderService, runAgentLoop } from './libs/agent-loop';
import { readProjectTree } from './libs/project-tree';
import {
  isTextLikeForOpenWith,
  openWithDisplayName,
  rankOpenWithAppPaths,
} from './libs/open-with-ranking';
import { isSameClaudeModelSelection, normalizeClaudeRequestedModel, reconcileClaudeDisplayModel } from './libs/claude-model-selection';
import { loadClaudeSettings, getClaudeSettings, getClaudeModelConfigWithCatalog, getMcpServers, getGlobalMcpServers, getProjectMcpServers, saveMcpServers, saveProjectMcpServers, type McpServerConfig } from './libs/claude-settings';
import { getCodexMcpServers, saveCodexMcpServers } from './libs/codex-mcp-settings';
import {
  getOpencodeMcpServers,
  saveOpencodeMcpServers,
  getOpencodeProjectMcpServers,
  saveOpencodeProjectMcpServers,
} from './libs/opencode-mcp-settings';
import {
  getKimiMcpServers,
  saveKimiMcpServers,
  getKimiProjectMcpServers,
  saveKimiProjectMcpServers,
} from './libs/kimi-mcp-settings';
import {
  loadCompatibleProviderConfig,
  saveCompatibleProviderConfig,
} from './libs/compatible-provider-config';
import { generateWechatMarkdownHtml } from './libs/wechat-html-generator';
import {
  loadWechatHtmlGeneratorConfig,
  saveWechatHtmlGeneratorConfig,
} from './libs/wechat-html-generator-config';
import {
  deleteImportedFont,
  getFontSettings,
  importFontFile,
  listSystemFonts,
  saveFontSelections,
} from './libs/font-settings';
import { getUserProfile, saveUserProfile } from './libs/user-profile';
import { getAgentRuntimeDirectory } from './libs/agent-runtime-directory';
import {
  getCodexModelConfig,
  saveCodexModelVisibility,
  setCodexRuntimeModelCatalog,
} from './libs/codex-settings';
import { getCodexRuntimeStatus } from './libs/codex-runtime-status';
import { getClaudePlanUsage } from './libs/claude-plan-usage';
import { getGrokPlanUsage } from './libs/grok-plan-usage';
import { getOpencodeModelConfig, saveOpencodeModelVisibility } from './libs/opencode-settings';
import { getOpencodeRuntimeStatus } from './libs/opencode-runtime-status';
import { getKimiModelConfig } from './libs/kimi-settings';
import { getGrokModelConfig } from './libs/grok-settings';
import { getPiModelConfig } from './libs/pi-settings';
import { formatKimiRuntimeBlockingMessage, getKimiRuntimeStatus } from './libs/kimi-runtime-status';
import { formatGrokRuntimeBlockingMessage, getGrokRuntimeStatus } from './libs/grok-runtime-status';
import { AutomationScheduler } from './libs/automation-scheduler';
import { recycleSessionWorktree } from './libs/worktree-hygiene';
import {
  applyIsolatedWorkspace,
  assignIsolatedWorkspace,
  branchSlugFromHint,
  discardIsolatedWorkspace,
  provisionIsolatedWorkspace,
  type IsolatedWorkspaceProvision,
} from './libs/worktree-threads';
import {
  configureNotifications,
  getNotificationSettings,
  notifySessionDone,
  setNotificationSettings,
} from './libs/notifications';
import {
  deletePromptLibraryItem,
  exportPromptLibraryFile,
  importPromptLibraryFile,
  listPromptLibraryItems,
  savePromptLibraryItem,
} from './libs/prompt-library';
import { expandClaudeSkillPrompt, listClaudeSkills } from './libs/claude-skills';
import { loadFeishuBridgeConfig, saveFeishuBridgeConfig } from './libs/feishu-bridge-config';
import { feishuBridge } from './libs/feishu-bridge';
import { getMemoryWorkspace, saveMemoryDocument } from './libs/memory-store';
import { formatClaudeRuntimeBlockingMessage, getClaudeRuntimeStatus, getClaudeRuntimeStatusCached, invalidateClaudeRuntimeCache } from './libs/claude-runtime-status';
import { selectClaudeRunnersToReap, type ClaudeRunnerSnapshot } from './libs/claude-runner-pool';
import {
  markClaudePromptDispatched,
  markClaudeInit,
  markClaudeFirstOutput,
  clearClaudeTurnMetrics,
} from './libs/claude-turn-metrics';
import {
  classifyResultForStop,
  isStoppedTurnDrainMessage,
  markTurnsStopped,
  resolveStopFallbackAction,
  shouldAutoDenyPermission,
  shouldDropRunnerErrorSilently,
  type StopStateSnapshot,
} from './libs/claude-stop-reconcile';
import {
  getSkillMarketDetail,
  getSkillMarketHot,
  installSkillFromMarket,
  searchSkillMarket,
} from './libs/skill-market';
import * as folderConfig from './libs/folder-config';
import { ipcMainHandle, isDev } from './util';
import { getHistorySourceForSession, toUnifiedSessionRecord } from './libs/history/registry';
import {
  SESSION_SUMMARY_CHUNK_MAX_CHARS,
  SESSION_SUMMARY_MAX_INCREMENTAL_UPDATES,
  buildSessionSummaryChunkPrompt,
  buildSessionSummaryPrompt,
  buildSessionSummarySourceIds,
  chunkSessionSummaryEntries,
  collectSessionSummaryEntries,
  isAppendOnlySessionSummaryUpdate,
  isSessionSummaryCurrent,
  parseSessionSummarySourceIds,
  type SessionSummaryEntry,
} from './libs/session-summary';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../shared/types';
import type {
  ClientEvent,
  ServerEvent,
  SessionInfo,
  StreamMessage,
  RunnerHandle,
  SessionState,
  PermissionResult,
  SessionStartPayload,
  SessionContinuePayload,
  SessionRow,
  PermissionRequestInput,
  PermissionResponsePayload,
  Attachment,
  SessionStatus,
} from './types';
import type {
  ClaudeCompatibleProvidersConfig,
  ClaudeCompatibleProviderId,
  ClaudeUsageRangeDays,
  FolderConfig,
  FontSettingsPayload,
  FeishuBridgeConfig,
  UserProfileUpdate,
  UpsertPromptLibraryItemInput,
  ProviderInputReference,
  SessionTeamMode,
  ProviderListPluginsInput,
  ProviderListSkillsInput,
  ProviderReadPluginInput,
  GitCheckoutBranchInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitPatchResult,
  GitPatchScope,
  GitSessionHandoffInput,
  GitPullRequestLookupStatus,
  OpenInEditorInput,
  EnvironmentEditorId,
  EnvironmentEditorLauncher,
  UpsertAutomationInput,
  WechatClipboardHtmlWriteInput,
  WechatMarkdownHtmlGenerationInput,
  WechatMarkdownHtmlGeneratorConfig,
  AgentProvider,
  ClaudeRewindInput,
  ClaudeRewindFilesOutcome,
  ClaudeRewindResult,
  SessionEnvironmentRecap,
} from '../shared/types';
import { buildSessionUserPromptSummaries } from '../shared/outline-summary';
import { getProviderService } from './libs/provider/service';
import { disposeTerminalRuntime } from './libs/terminal-runtime';
import { disposeTerminalTransportServer } from './libs/terminal-transport-server';

// === IPC 模块导入（从 ipc-handlers.ts 拆分） ===
import { register as registerTerminal } from './ipc/terminal'
import { register as registerFeishu } from './ipc/feishu'
import { register as registerPromptLibrary } from './ipc/prompt-library'
import { register as registerMemory } from './ipc/memory'
import { register as registerFont } from './ipc/font'
import { register as registerSkillMarket } from './ipc/skill-market'
import {
  applyStash,
  checkoutBranch,
  createBranch,
  createWorktree,
  dropStash,
  getCurrentBranch,
  getGitTopLevel,
  listBranches as listGitBranches,
  removeWorktree,
  stashWorkingTree,
} from './libs/git-service';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_STREAMING_PDF_PREVIEW_BYTES = 200 * 1024 * 1024; // 200MB
const DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS = 20_000;
const LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD = 500;
const LONG_PROMPT_ATTACHMENT_INSTRUCTION =
  'The main request is attached as a text file. Read the attachment first, then respond normally.';

function normalizeWorkspaceChannelId(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_WORKSPACE_CHANNEL_ID;
}

function normalizeSessionScope(value?: string | null): SessionInfo['scope'] {
  return value === 'dm' ? 'dm' : 'project';
}

function normalizeSessionTeamMode(value?: string | null): SessionTeamMode {
  return value === 'solo' || value === 'team' || value === 'manual'
    ? value
    : 'channel_default';
}

function getDirectMessageRuntimeCwd(): string {
  const runtimeCwd = join(app.getPath('userData'), 'direct-message-runtime');
  if (!existsSync(runtimeCwd)) {
    mkdirSync(runtimeCwd, { recursive: true });
  }
  return runtimeCwd;
}

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
const MARKDOWN_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const LOCAL_PREVIEW_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
};

const projectWatchers = new Map<
  string,
  { watcher: FSWatcher; timer?: NodeJS.Timeout }
>();
const projectTreeVersions = new Map<string, number>();
const PROJECT_TREE_REFRESH_DELAY_MS = 200;
const PROJECT_TREE_DELETE_SETTLE_TIMEOUT_MS = 2500;
const PROJECT_TREE_DELETE_SETTLE_INTERVAL_MS = 50;

function getProjectTreeVersionKey(cwd: string): string {
  return resolve(cwd);
}

function getProjectTreeVersion(cwd: string): number {
  return projectTreeVersions.get(getProjectTreeVersionKey(cwd)) ?? 0;
}

function bumpProjectTreeVersion(cwd: string): void {
  const key = getProjectTreeVersionKey(cwd);
  projectTreeVersions.set(key, (projectTreeVersions.get(key) ?? 0) + 1);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForPathToDisappear(filePath: string): Promise<boolean> {
  const deadline = Date.now() + PROJECT_TREE_DELETE_SETTLE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      await fsPromises.lstat(filePath);
    } catch (error) {
      if (isMissingPathError(error)) return true;
      throw error;
    }

    if (Date.now() >= deadline) break;
    await wait(PROJECT_TREE_DELETE_SETTLE_INTERVAL_MS);
  }
  return false;
}

const projectFileWatchers = new Map<
  string,
  { watcher: FSWatcher; timer?: NodeJS.Timeout; cwd: string; filePath: string; base: string }
>();

function projectFileWatchKey(cwd: string, filePath: string): string {
  return `${resolve(cwd || '.')}\u0000${resolve(cwd || '.', filePath || '')}`;
}

function closeProjectFileWatcher(key: string): void {
  const entry = projectFileWatchers.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  try {
    entry.watcher.close();
  } catch {
    // watcher may already be closed
  }
  projectFileWatchers.delete(key);
}

async function writeTextFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  );

  try {
    await fsPromises.writeFile(tempPath, content, { encoding: 'utf8', mode });
    await fsPromises.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function closeProjectTreeWatcher(cwd: string): void {
  const entry = projectWatchers.get(cwd);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.watcher.close();
  projectWatchers.delete(cwd);
  projectTreeVersions.delete(getProjectTreeVersionKey(cwd));
}

const localPreviewServers = new Map<string, {
  server: HttpServer;
  port: number;
  token: string;
}>();
function normalizeShellPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return app.getPath('home');
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(app.getPath('home'), trimmed.slice(2));
  }

  return trimmed;
}

function normalizeCodexPermissionMode(
  value?: string | null
): import('../shared/types').CodexPermissionMode {
  if (value === 'fullAccess' || value === 'fullAuto') return 'fullAccess';
  // 'auto' is a real protocol mode (approvalsReviewer: auto_review) — this
  // normalizer used to silently downgrade it to defaultPermissions (P0-2).
  if (value === 'auto' || value === 'autoReview') return 'auto';
  return 'defaultPermissions';
}

function normalizeCodexExecutionMode(
  value?: string | null
): import('../shared/types').CodexExecutionMode {
  return value === 'plan' ? 'plan' : 'execute';
}

function normalizeCodexReasoningEffort(
  value?: string | null
): import('../shared/types').CodexReasoningEffort | undefined {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value!.trim().toLowerCase() as import('../shared/types').CodexReasoningEffort;
    default:
      return undefined;
  }
}

function normalizeCodexFastMode(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function normalizeOpenCodePermissionMode(
  value?: string | null
): import('../shared/types').OpenCodePermissionMode {
  if (value === 'plan') {
    return 'plan';
  }

  return value === 'fullAccess' || value === 'fullAuto'
    ? 'fullAccess'
    : 'defaultPermissions';
}

function normalizeKimiPermissionMode(
  value?: string | null
): import('../shared/types').KimiPermissionMode {
  return value === 'plan' || value === 'auto' || value === 'yolo' ? value : 'default';
}

function normalizeGrokPermissionMode(
  value?: string | null
): import('../shared/types').GrokPermissionMode | undefined {
  return value === 'plan' || value === 'auto' || value === 'yolo' || value === 'default'
    ? value
    : undefined;
}

function normalizeGrokReasoningEffort(
  value?: string | null
): import('../shared/types').GrokReasoningEffort | undefined {
  switch ((value || '').trim().toLowerCase()) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value!.trim().toLowerCase() as import('../shared/types').GrokReasoningEffort;
    default:
      return undefined;
  }
}

function normalizeClaudeAccessMode(
  value?: string | null
): import('../shared/types').ClaudeAccessMode {
  switch ((value || '').trim()) {
    case 'fullAccess':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return value as import('../shared/types').ClaudeAccessMode;
    default:
      return 'default';
  }
}

function normalizeClaudeExecutionMode(
  value?: string | null,
  accessMode?: string | null
): import('../shared/types').ClaudeExecutionMode {
  if (normalizeClaudeAccessMode(accessMode) === 'plan') {
    return 'plan';
  }
  return value === 'plan' ? 'plan' : 'execute';
}

function normalizeClaudeReasoningEffort(
  value?: string | null
): import('../shared/types').ClaudeReasoningEffort {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value!.trim().toLowerCase() as import('../shared/types').ClaudeReasoningEffort;
    default:
      return 'high';
  }
}

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown' | 'html';
      path: string;
      name: string;
      ext: string;
      size: number;
      mtimeMs: number;
      text: string;
      editable: boolean;
    }
  | {
      kind: 'image';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataUrl: string;
    }
  | {
      kind: 'pdf';
      path: string;
      name: string;
      ext: string;
      size: number;
      previewUrl?: string;
      dataBase64?: string;
      dataUrl?: string;
    }
  | {
      kind: 'pptx';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64: string;
    }
  | {
      kind: 'csv';
      path: string;
      name: string;
      ext: string;
      size: number;
      mtimeMs: number;
      text: string;
    }
  | {
      kind: 'xlsx';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64: string;
    }
  | {
      kind: 'binary' | 'unsupported';
      path: string;
      name: string;
      ext: string;
      size: number;
    }
  | {
      kind: 'too_large';
      path: string;
      name: string;
      ext: string;
      size: number;
      maxBytes: number;
    }
  | {
      kind: 'error';
      path: string;
      name: string;
      ext: string;
      message: string;
    };

function isPathWithinRoot(rootPath: string, filePath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(filePath);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function validateProjectFilePath(
  cwd: string,
  filePath: string
): Promise<{ ok: true; rootReal: string; targetReal: string } | { ok: false; message: string }> {
  if (!cwd || !filePath) {
    return { ok: false, message: 'Missing cwd or file path' };
  }

  if (!isPathWithinRoot(cwd, filePath)) {
    return { ok: false, message: 'File is outside the selected project folder' };
  }

  try {
    const [rootReal, targetReal] = await Promise.all([
      fsPromises.realpath(cwd),
      fsPromises.realpath(filePath),
    ]);
    if (!isPathWithinRoot(rootReal, targetReal)) {
      return { ok: false, message: 'File is outside the selected project folder' };
    }
    return { ok: true, rootReal, targetReal };
  } catch (error) {
    // realpath fails if file is missing; still keep the basic path containment check above.
    return { ok: true, rootReal: resolve(cwd), targetReal: resolve(filePath) };
  }
}

function validateProjectEntryName(name: string): { ok: true; name: string } | { ok: false; message: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, message: 'Name is required.' };
  }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, message: 'Name cannot be "." or "..".' };
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || basename(trimmed) !== trimmed) {
    return { ok: false, message: 'Name cannot contain path separators.' };
  }
  return { ok: true, name: trimmed };
}

async function createProjectEntry(
  cwd: string,
  parentPath: string,
  name: string,
  kind: 'file' | 'folder'
): Promise<{ ok: true; path: string; tree: NonNullable<Awaited<ReturnType<typeof readProjectTree>>> } | { ok: false; message: string }> {
  if (!cwd) {
    return { ok: false, message: 'Missing project folder.' };
  }

  const nameValidation = validateProjectEntryName(name);
  if (!nameValidation.ok) {
    return nameValidation;
  }

  const projectRoot = resolve(cwd);
  const parentResolved = resolve(projectRoot, parentPath || projectRoot);
  if (!isPathWithinRoot(projectRoot, parentResolved)) {
    return { ok: false, message: 'Parent folder is outside the selected project folder.' };
  }

  let rootReal: string;
  let parentReal: string;
  try {
    [rootReal, parentReal] = await Promise.all([
      fsPromises.realpath(projectRoot),
      fsPromises.realpath(parentResolved),
    ]);
  } catch {
    return { ok: false, message: 'Parent folder was not found.' };
  }

  if (!isPathWithinRoot(rootReal, parentReal)) {
    return { ok: false, message: 'Parent folder is outside the selected project folder.' };
  }

  let parentStat;
  try {
    parentStat = await fsPromises.stat(parentResolved);
  } catch {
    return { ok: false, message: 'Parent folder was not found.' };
  }
  if (!parentStat.isDirectory()) {
    return { ok: false, message: 'Parent path is not a folder.' };
  }

  const targetPath = resolve(parentResolved, nameValidation.name);
  if (!isPathWithinRoot(projectRoot, targetPath)) {
    return { ok: false, message: 'Target path is outside the selected project folder.' };
  }

  try {
    await fsPromises.lstat(targetPath);
    return { ok: false, message: 'A file or folder with that name already exists.' };
  } catch {
    // Missing is the expected state before creating a new entry.
  }

  try {
    if (kind === 'folder') {
      await fsPromises.mkdir(targetPath);
    } else {
      const handle = await fsPromises.open(targetPath, 'wx');
      await handle.close();
    }
    const tree = await readProjectTree(projectRoot);
    if (!tree) {
      return { ok: false, message: 'Project folder was not found.' };
    }
    return { ok: true, path: targetPath, tree };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to create ${kind === 'folder' ? 'folder' : 'file'}: ${String(error)}`,
    };
  }
}

async function moveProjectEntry(
  cwd: string,
  sourcePath: string,
  targetParentPath: string
): Promise<{ ok: true; path: string; tree: NonNullable<Awaited<ReturnType<typeof readProjectTree>>> } | { ok: false; message: string }> {
  if (!cwd || !sourcePath || !targetParentPath) {
    return { ok: false, message: 'Missing project folder or file path.' };
  }

  const projectRoot = resolve(cwd);
  const sourceResolved = resolve(projectRoot, sourcePath);
  const targetParentResolved = resolve(projectRoot, targetParentPath);

  if (!isPathWithinRoot(projectRoot, sourceResolved) || sourceResolved === projectRoot) {
    return { ok: false, message: 'Source is outside the selected project folder.' };
  }
  if (!isPathWithinRoot(projectRoot, targetParentResolved)) {
    return { ok: false, message: 'Target folder is outside the selected project folder.' };
  }

  let rootReal: string;
  let sourceReal: string;
  let targetParentReal: string;
  try {
    [rootReal, sourceReal, targetParentReal] = await Promise.all([
      fsPromises.realpath(projectRoot),
      fsPromises.realpath(sourceResolved),
      fsPromises.realpath(targetParentResolved),
    ]);
  } catch {
    return { ok: false, message: 'Source file or target folder was not found.' };
  }

  if (!isPathWithinRoot(rootReal, sourceReal) || sourceReal === rootReal) {
    return { ok: false, message: 'Source is outside the selected project folder.' };
  }
  if (!isPathWithinRoot(rootReal, targetParentReal)) {
    return { ok: false, message: 'Target folder is outside the selected project folder.' };
  }

  let sourceStat;
  let targetParentStat;
  try {
    [sourceStat, targetParentStat] = await Promise.all([
      fsPromises.lstat(sourceResolved),
      fsPromises.stat(targetParentReal),
    ]);
  } catch {
    return { ok: false, message: 'Source file or target folder was not found.' };
  }

  if (!targetParentStat.isDirectory()) {
    return { ok: false, message: 'Target path is not a folder.' };
  }

  if (sourceStat.isDirectory() && isPathWithinRoot(sourceReal, targetParentReal)) {
    return { ok: false, message: 'Cannot move a folder into itself.' };
  }

  if (resolve(dirname(sourceResolved)) === resolve(targetParentReal)) {
    return { ok: false, message: 'File is already in that folder.' };
  }

  const targetPath = resolve(targetParentReal, basename(sourceResolved));
  if (!isPathWithinRoot(rootReal, targetPath)) {
    return { ok: false, message: 'Target path is outside the selected project folder.' };
  }

  try {
    await fsPromises.lstat(targetPath);
    return { ok: false, message: 'A file or folder with that name already exists in the target folder.' };
  } catch {
    // Missing is the expected state before moving an entry.
  }

  try {
    try {
      await fsPromises.rename(sourceResolved, targetPath);
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException)?.code;
      if (code !== 'EXDEV') throw renameError;
      // Cross-device move: copy then remove. cp handles both files and directories recursively.
      await fsPromises.cp(sourceResolved, targetPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      try {
        await fsPromises.rm(sourceResolved, { recursive: true, force: false });
      } catch (cleanupError) {
        // The copy succeeded; surface the cleanup failure so the user knows the source still exists.
        return {
          ok: false,
          message: `Copied to target but failed to remove source: ${String(cleanupError)}`,
        };
      }
    }
    const tree = await readProjectTree(projectRoot);
    if (!tree) {
      return { ok: false, message: 'Project folder was not found.' };
    }
    return { ok: true, path: targetPath, tree };
  } catch (error) {
    return { ok: false, message: `Failed to move file: ${String(error)}` };
  }
}

async function deleteProjectEntry(
  cwd: string,
  targetPath: string
): Promise<{ ok: true; tree: NonNullable<Awaited<ReturnType<typeof readProjectTree>>> } | { ok: false; message: string }> {
  if (!cwd || !targetPath) {
    return { ok: false, message: 'Missing project folder or file path.' };
  }

  const projectRoot = resolve(cwd);
  const targetResolved = resolve(projectRoot, targetPath);

  if (!isPathWithinRoot(projectRoot, targetResolved) || targetResolved === projectRoot) {
    return { ok: false, message: 'Target is outside the selected project folder.' };
  }

  let rootReal: string;
  let targetReal: string;
  try {
    [rootReal, targetReal] = await Promise.all([
      fsPromises.realpath(projectRoot),
      fsPromises.realpath(targetResolved),
    ]);
  } catch {
    return { ok: false, message: 'File or folder was not found.' };
  }

  if (!isPathWithinRoot(rootReal, targetReal) || targetReal === rootReal) {
    return { ok: false, message: 'Target is outside the selected project folder.' };
  }

  bumpProjectTreeVersion(projectRoot);
  try {
    // Move to OS trash for safety/recoverability. shell.trashItem works for files and folders.
    await shell.trashItem(targetResolved);
    const removed = await waitForPathToDisappear(targetResolved);
    if (!removed) {
      return { ok: false, message: 'File still exists after moving to Trash.' };
    }
  } catch (error) {
    return { ok: false, message: `Failed to delete: ${String(error)}` };
  } finally {
    bumpProjectTreeVersion(projectRoot);
  }

  const tree = await readProjectTree(projectRoot);
  if (!tree) {
    return { ok: false, message: 'Project folder was not found.' };
  }
  return { ok: true, tree };
}

function decodeMarkdownAssetPath(assetPath: string): string {
  try {
    return decodeURI(assetPath);
  } catch {
    return assetPath;
  }
}

function getMarkdownImageExtension(fileName: string, mimeType?: string): string | null {
  const ext = extname(fileName || '').toLowerCase();
  if (MARKDOWN_IMAGE_MIME_TYPES[ext]) return ext;

  switch ((mimeType || '').toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return null;
  }
}

function toIpcBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  return null;
}

async function createMarkdownImageAsset(
  cwd: string,
  markdownFilePath: string,
  sourceFileName: string,
  mimeType: string | undefined,
  data: unknown
): Promise<{ ok: true; relativePath: string; name: string } | { ok: false; message: string }> {
  if (!cwd || !markdownFilePath) {
    return { ok: false, message: 'Missing project or Markdown file path.' };
  }

  const buffer = toIpcBuffer(data);
  if (!buffer || buffer.length === 0) {
    return { ok: false, message: 'Missing image data.' };
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, message: 'Selected image is too large.' };
  }

  const ext = getMarkdownImageExtension(sourceFileName, mimeType);
  if (!ext) {
    return { ok: false, message: 'Only image files can be inserted.' };
  }

  const resolvedMarkdown = resolve(cwd || '.', markdownFilePath || '');
  const markdownValidation = await validateProjectFilePath(cwd, resolvedMarkdown);
  if (!markdownValidation.ok) {
    return { ok: false, message: markdownValidation.message };
  }

  const markdownDir = resolve(markdownValidation.targetReal, '..');
  const markdownBase = basename(markdownValidation.targetReal).replace(/\.(md|markdown)$/i, '') || 'document';
  const assetDir = resolve(markdownDir, `${markdownBase}.assets`);
  if (!isPathWithinRoot(cwd, assetDir)) {
    return { ok: false, message: 'Image asset directory is outside the project.' };
  }

  const safeBaseName = basename(sourceFileName || 'image', ext)
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'image';

  let fileName = `${safeBaseName}${ext}`;
  let targetPath = resolve(assetDir, fileName);
  let suffix = 2;
  while (existsSync(targetPath)) {
    fileName = `${safeBaseName}-${suffix}${ext}`;
    targetPath = resolve(assetDir, fileName);
    suffix += 1;
  }

  if (!isPathWithinRoot(cwd, targetPath)) {
    return { ok: false, message: 'Image asset target is outside the project.' };
  }

  try {
    await fsPromises.mkdir(assetDir, { recursive: true });
    await fsPromises.writeFile(targetPath, buffer);
  } catch (error) {
    return { ok: false, message: `Failed to write image: ${String(error)}` };
  }

  const relativePath = relative(markdownDir, targetPath).replace(/\\/g, '/');
  return { ok: true, relativePath, name: fileName };
}

async function readMarkdownImageAsset(
  cwd: string,
  markdownFilePath: string,
  imageSrc: string
): Promise<{ ok: true; dataUrl: string } | { ok: false; message: string }> {
  const resolved = await resolveMarkdownImageAssetFile(cwd, markdownFilePath, imageSrc);
  if (!resolved.ok) return resolved;

  try {
    const buffer = await fsPromises.readFile(resolved.targetReal);
    return {
      ok: true,
      dataUrl: `data:${resolved.mimeType};base64,${buffer.toString('base64')}`,
    };
  } catch (error) {
    return { ok: false, message: `Failed to read image: ${String(error)}` };
  }
}

async function resolveMarkdownImageAssetFile(
  cwd: string,
  markdownFilePath: string,
  imageSrc: string
): Promise<{
  ok: true;
  rootReal: string;
  targetReal: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
} | { ok: false; message: string }> {
  const trimmedSrc = imageSrc.trim();
  if (!cwd || !markdownFilePath || !trimmedSrc) {
    return { ok: false, message: 'Missing project, Markdown file, or image path.' };
  }

  if (/^(https?:|data:|blob:|mailto:)/i.test(trimmedSrc)) {
    return { ok: false, message: 'Remote or inline images do not need local resolution.' };
  }

  const markdownResolved = resolve(cwd || '.', markdownFilePath || '');
  const markdownValidation = await validateProjectFilePath(cwd, markdownResolved);
  if (!markdownValidation.ok) {
    return { ok: false, message: markdownValidation.message };
  }

  let imagePath: string;
  if (/^file:/i.test(trimmedSrc)) {
    try {
      imagePath = fileURLToPath(trimmedSrc);
    } catch {
      return { ok: false, message: 'Invalid file URL for image.' };
    }
  } else {
    const normalizedSrc = decodeMarkdownAssetPath(trimmedSrc).replace(/\\/g, '/');
    imagePath = isAbsolute(normalizedSrc)
      ? normalizedSrc
      : resolve(dirname(markdownValidation.targetReal), normalizedSrc);
  }

  const imageValidation = await validateProjectFilePath(cwd, imagePath);
  if (!imageValidation.ok) {
    return { ok: false, message: imageValidation.message };
  }

  const ext = extname(imageValidation.targetReal).toLowerCase();
  const mimeType = MARKDOWN_IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    return { ok: false, message: 'Only image files can be rendered in Markdown.' };
  }

  let stat;
  try {
    stat = await fsPromises.stat(imageValidation.targetReal);
  } catch {
    return { ok: false, message: 'Image file was not found.' };
  }
  if (!stat.isFile()) {
    return { ok: false, message: 'Image path is not a file.' };
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, message: 'Image is too large to preview inline.' };
  }

  return {
    ok: true,
    rootReal: imageValidation.rootReal,
    targetReal: imageValidation.targetReal,
    mimeType,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function resolveMarkdownImageAssetUrl(
  cwd: string,
  markdownFilePath: string,
  imageSrc: string
): Promise<{ ok: true; url: string; size: number; mtimeMs: number } | { ok: false; message: string }> {
  const resolved = await resolveMarkdownImageAssetFile(cwd, markdownFilePath, imageSrc);
  if (!resolved.ok) return resolved;

  try {
    const preview = await getLocalPreviewUrl(resolved.rootReal, resolved.targetReal);
    if (!preview.ok) return preview;
    const version = `${Math.round(resolved.mtimeMs)}-${resolved.size}`;
    const url = new URL(preview.url);
    url.searchParams.set('aegis-cache', 'markdown-image');
    url.searchParams.set('v', version);
    return {
      ok: true,
      url: url.toString(),
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
    };
  } catch (error) {
    return { ok: false, message: `Failed to create image preview URL: ${String(error)}` };
  }
}

function getLocalPreviewMimeType(filePath: string): string {
  return LOCAL_PREVIEW_MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function toPreviewUrlPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment));
  return `/${segments.join('/')}`;
}

function sendPreviewResponse(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

type LocalPreviewCacheMode = 'default' | 'markdown-image';

function parsePreviewByteRange(
  rangeHeader: string | string[] | undefined,
  size: number
): { start: number; end: number } | 'invalid' | null {
  const header = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  if (!header) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '') || size <= 0) {
    return 'invalid';
  }

  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }
    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return 'invalid';
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

function streamPreviewFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
  cacheMode: LocalPreviewCacheMode = 'default'
): void {
  const mimeType = getLocalPreviewMimeType(filePath);
  const range = parsePreviewByteRange(req.headers.range, size);
  const cacheControl = cacheMode === 'markdown-image' && mimeType.startsWith('image/')
    ? 'private, max-age=300'
    : 'no-store';

  if (range === 'invalid') {
    res.writeHead(416, {
      'Content-Range': `bytes */${size}`,
      'Cache-Control': cacheControl,
      'Accept-Ranges': 'bytes',
    });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(size - 1, 0);
  const contentLength = range ? end - start + 1 : size;
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(contentLength),
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  if (size === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on('error', (error) => {
    if (!res.headersSent) {
      sendPreviewResponse(res, 500, `Failed to read preview file: ${String(error)}`);
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
}

async function resolvePreviewRequestFile(rootReal: string, requestPathname: string): Promise<string | null> {
  const relativePath = requestPathname.replace(/^\/+/, '');
  let targetPath = resolve(rootReal, relativePath || '.');
  if (!isPathWithinRoot(rootReal, targetPath)) {
    return null;
  }

  try {
    targetPath = await fsPromises.realpath(targetPath);
  } catch {
    // keep resolved path for regular files that may not need realpath normalization
  }

  if (!isPathWithinRoot(rootReal, targetPath)) {
    return null;
  }

  let stat;
  try {
    stat = await fsPromises.stat(targetPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    const indexPath = resolve(targetPath, 'index.html');
    if (!isPathWithinRoot(rootReal, indexPath)) {
      return null;
    }
    try {
      const indexReal = await fsPromises.realpath(indexPath).catch(() => indexPath);
      if (!isPathWithinRoot(rootReal, indexReal)) {
        return null;
      }
      const indexStat = await fsPromises.stat(indexReal);
      return indexStat.isFile() ? indexReal : null;
    } catch {
      return null;
    }
  }

  return stat.isFile() ? targetPath : null;
}

async function handleLocalPreviewRequest(
  rootReal: string,
  token: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPreviewResponse(res, 405, 'Method not allowed');
    return;
  }

  let pathname = '/';
  let cacheMode: LocalPreviewCacheMode = 'default';
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    pathname = decodeURIComponent(url.pathname);
    cacheMode = url.searchParams.get('aegis-cache') === 'markdown-image'
      ? 'markdown-image'
      : 'default';
  } catch {
    sendPreviewResponse(res, 400, 'Invalid request path');
    return;
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== token) {
    sendPreviewResponse(res, 404, 'Not found');
    return;
  }

  const filePath = await resolvePreviewRequestFile(rootReal, `/${segments.slice(1).join('/')}`);
  if (!filePath) {
    sendPreviewResponse(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) {
      sendPreviewResponse(res, 404, 'Not found');
      return;
    }
    streamPreviewFile(req, res, filePath, stat.size, cacheMode);
  } catch (error) {
    sendPreviewResponse(res, 500, `Failed to read preview file: ${String(error)}`);
  }
}

async function ensureLocalPreviewServer(rootReal: string): Promise<{ port: number; token: string }> {
  const existing = localPreviewServers.get(rootReal);
  if (existing) {
    return { port: existing.port, token: existing.token };
  }

  const token = uuidv4();
  const server = createServer((req, res) => {
    void handleLocalPreviewRequest(rootReal, token, req, res);
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const handleError = (error: Error) => {
      server.removeListener('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.removeListener('error', handleError);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== 'number') {
        reject(new Error('Failed to determine preview server port'));
        return;
      }
      resolvePort(address.port);
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, '127.0.0.1');
  });

  server.unref();
  server.once('close', () => {
    localPreviewServers.delete(rootReal);
  });
  localPreviewServers.set(rootReal, { server, port, token });
  return { port, token };
}

async function getLocalPreviewUrl(
  rootReal: string,
  targetReal: string
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const { port, token } = await ensureLocalPreviewServer(rootReal);
  const relativePath = relative(rootReal, targetReal);
  return {
    ok: true,
    url: `http://127.0.0.1:${port}/${token}${toPreviewUrlPath(relativePath)}`,
  };
}

async function getHtmlPreviewUrl(
  cwd: string,
  filePath: string
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const resolvedPath = resolve(cwd || '.', filePath || '');
  const validation = await validateProjectFilePath(cwd, resolvedPath);
  if (!validation.ok) {
    return validation;
  }

  const ext = extname(validation.targetReal).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    return { ok: false, message: 'Only HTML files can be previewed in the browser' };
  }

  try {
    const stat = await fsPromises.stat(validation.targetReal);
    if (!stat.isFile()) {
      return { ok: false, message: 'Preview target is not a file' };
    }
  } catch {
    return { ok: false, message: 'Preview file was not found' };
  }

  return getLocalPreviewUrl(validation.rootReal, validation.targetReal);
}

function getAttachmentSpec(filePath: string): { kind: Attachment['kind']; mimeType: string } | null {
  const ext = extname(filePath).toLowerCase();
  const mimeType = ATTACHMENT_MIME_TYPES[ext];
  if (!mimeType) {
    return null;
  }

  const kind: Attachment['kind'] = ext === '.png' || ext === '.jpg' || ext === '.jpeg' ? 'image' : 'file';
  return { kind, mimeType };
}


function normalizeModel(model?: string | null): string | undefined {
  return normalizeClaudeRequestedModel(model);
}

function normalizeBetas(betas?: string[] | null): string[] | undefined {
  if (!Array.isArray(betas)) {
    return undefined;
  }

  const normalized = betas
    .map((beta) => (typeof beta === 'string' ? beta.trim() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function parseStoredBetas(raw?: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeBetas(Array.isArray(parsed) ? parsed : undefined);
  } catch {
    return undefined;
  }
}

function parseSlashCommand(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.+))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

async function buildRunnerPromptWithMemory(
  _provider: SessionInfo['provider'],
  prompt: string,
  _cwd?: string
): Promise<string> {
  // Memory context and tool guidance are now injected via systemPrompt.append
  // in runner.ts (in-process MCP approach). No longer pollute the user prompt.
  return prompt.trim();
}

const LIVE_WIDGET_VISUAL_PATTERN =
  /(?:\bwidget\b|\bdashboard\b|\bchart\b|\bdiagram\b|\bprototype\b|\banimation\b|\binteractive\b|\blanding page\b|\bweb page\b|\bhero section\b|网页|页面|前端|组件|动画|交互|可视化|图表|仪表盘|原型|落地页)/i;
const LIVE_WIDGET_PREVIEW_INTENT_PATTERN =
  /(?:live preview|inline preview|render (?:it|this|that)? ?(?:in|inside)? ?chat|show (?:it|this|that)? ?(?:in|inside)? ?chat|preview (?:it|this|that)? ?(?:in|inside)? ?chat|display (?:it|this|that)? ?(?:in|inside)? ?chat|direct preview|render it here|show it here|preview it here|直接预览|实时预览|聊天里预览|在聊天里预览|直接展示|聊天里展示|在聊天里展示|直接渲染|实时渲染|聊天内渲染|在聊天中渲染|直接在回复里展示|直接在回复里预览|直接在对话里预览|直接在对话里展示)/i;
const LIVE_WIDGET_FOLLOWUP_PATTERN =
  /(?:continue|iterate|refine|tweak|adjust|improve|polish|update|modify|继续|接着|再改|优化|调整|微调|完善).*(?:widget|preview|component|demo|card|这个预览|这个组件|这个卡片)|(?:widget|preview|component|demo|card|这个预览|这个组件|这个卡片).*(?:continue|iterate|refine|tweak|adjust|improve|polish|update|modify|继续|接着|再改|优化|调整|微调|完善)/i;

function streamMessageContainsLiveWidget(message: StreamMessage): boolean {
  if (message.type === 'user_prompt') {
    return message.prompt.includes('<aegis-widget');
  }

  if (message.type === 'assistant' || message.type === 'user') {
    return message.message.content.some((block) => {
      if (block.type === 'text') {
        return block.text.includes('<aegis-widget');
      }
      if (block.type === 'tool_result') {
        return block.content.includes('<aegis-widget');
      }
      return false;
    });
  }

  return false;
}

function augmentPromptForLiveWidgetProtocol(
  prompt: string,
  history?: StreamMessage[]
): string {
  if (!prompt.trim()) {
    return prompt;
  }

  if (prompt.includes('<aegis-widget')) {
    return prompt;
  }

  const hasWidgetHistory = history ? history.some((message) => streamMessageContainsLiveWidget(message)) : false;
  const hasExplicitPreviewIntent = LIVE_WIDGET_PREVIEW_INTENT_PATTERN.test(prompt);
  const isVisualRequest = LIVE_WIDGET_VISUAL_PATTERN.test(prompt);
  const isWidgetFollowup = hasWidgetHistory && LIVE_WIDGET_FOLLOWUP_PATTERN.test(prompt);
  const shouldInject =
    (hasExplicitPreviewIntent && isVisualRequest) ||
    (hasExplicitPreviewIntent && hasWidgetHistory) ||
    isWidgetFollowup;

  if (!shouldInject) {
    return prompt;
  }

  return [
    prompt.trim(),
    '',
    'If a live visual preview would help, you may embed exactly one self-contained widget block using this format:',
    '<aegis-widget title="short title">',
    '<!doctype html><html><body>...</body></html>',
    '</aegis-widget>',
    'Rules: keep it self-contained, responsive, inline CSS/JS only, no external network fetches, and keep all explanation outside the widget block.',
  ].join('\n');
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatProviderLabel(provider: SessionInfo['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'kimi') return 'Kimi Code';
  if (provider === 'grok') return 'Grok Build';
  if (provider === 'pi') return 'Pi';
  return 'Claude Code';
}

function buildLocalAssistantMessage(text: string): StreamMessage {
  return {
    type: 'assistant',
    uuid: uuidv4(),
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

function shouldPersistProviderMessage(message: StreamMessage): boolean {
  if (message.type === 'stream_event') {
    return false;
  }
  if (message.type === 'assistant' && message.streaming === true) {
    return false;
  }
  return true;
}

function createAgentRunId(agentId?: string | null, kind = 'turn'): string | null {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) {
    return null;
  }

  const safeAgentId = normalizedAgentId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `agent-run:${safeAgentId || 'agent'}:${kind}:${uuidv4()}`;
}

function withAgentAttribution(
  message: StreamMessage,
  agentId?: string | null,
  agentRunId?: string | null
): StreamMessage {
  const normalizedAgentId = agentId?.trim();
  const normalizedAgentRunId = agentRunId?.trim();
  if (message.type !== 'assistant' || (!normalizedAgentId && !normalizedAgentRunId)) {
    return message;
  }
  return {
    ...message,
    ...(normalizedAgentId ? { agentId: normalizedAgentId } : {}),
    ...(normalizedAgentRunId ? { agentRunId: normalizedAgentRunId } : {}),
  };
}

function buildSessionCostSummary(session: ReturnType<typeof sessions.getSession>): string {
  if (!session) {
    return 'No active session found.';
  }

  const history = sessions.getSessionHistory(session.id);
  const resultMessages = history.filter(
    (message): message is StreamMessage & { type: 'result' } => message.type === 'result'
  );

  if (resultMessages.length === 0) {
    return [
      '**Session usage**',
      '',
      `- Provider: ${formatProviderLabel(session.provider)}`,
      `- Model: ${session.model || 'Unknown'}`,
      '- No completed turns with usage data yet.',
    ].join('\n');
  }

  const totalInputTokens = resultMessages.reduce(
    (sum, message) => sum + (message.usage?.input_tokens || 0),
    0
  );
  const totalOutputTokens = resultMessages.reduce(
    (sum, message) => sum + (message.usage?.output_tokens || 0),
    0
  );
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalCostUsd = resultMessages.reduce(
    (sum, message) => sum + (message.total_cost_usd || 0),
    0
  );
  const totalDurationMs = resultMessages.reduce(
    (sum, message) => sum + (message.duration_ms || 0),
    0
  );

  return [
    '**Session usage**',
    '',
    `- Provider: ${formatProviderLabel(session.provider)}`,
    `- Model: ${session.model || 'Unknown'}`,
    `- Completed turns: ${formatInteger(resultMessages.length)}`,
    `- Input tokens: ${formatInteger(totalInputTokens)}`,
    `- Output tokens: ${formatInteger(totalOutputTokens)}`,
    `- Total tokens: ${formatInteger(totalTokens)}`,
    `- Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
    `- Total cost: $${totalCostUsd.toFixed(4)}`,
  ].join('\n');
}

function buildUnsupportedSlashCommandMessage(commandName: string): string {
  return [
    `\`/${commandName}\` is not implemented in Aegis yet.`,
    '',
    'This command is advertised from Claude Code slash commands, but this desktop app does not execute that built-in command yet.',
  ].join('\n');
}

function findLatestProposedPlan(history: StreamMessage[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.type === 'proposed_plan') {
      const planMarkdown = message.planMarkdown.trim();
      if (planMarkdown) {
        return planMarkdown;
      }
    }
  }

  return null;
}

function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

function isPlanImplementationConfirmation(prompt: string): boolean {
  const compact = prompt.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return true;
  }

  const lower = compact.toLowerCase();
  if (/^(ok|okay|yes|approved|approve|accepted|accept|go ahead|looks good|ship it)[.!?, ]*$/i.test(compact)) {
    return true;
  }

  if (/\b(implement|execute|apply|proceed with|start|continue)\b.*\b(plan|proposal)\b/i.test(lower)) {
    return true;
  }

  if (/^(同意|批准|可以|好|好的|行|没问题|确认)(这个|该|这份)?(计划|方案)?[。！!，,. ]*$/.test(compact)) {
    return true;
  }

  return /(执行|实现|开始|继续|按|照).*(这个|该|这份)?(计划|方案)/.test(compact);
}

function maybeBuildPlanImplementationPrompt(prompt: string, planMarkdown: string | null): string | null {
  if (!planMarkdown || !isPlanImplementationConfirmation(prompt)) {
    return null;
  }

  return buildPlanImplementationPrompt(planMarkdown);
}

function normalizeSlashName(name: string): string {
  return name.replace(/^\//, '').trim().toLowerCase();
}

function isZeroTokenResult(message: Extract<StreamMessage, { type: 'result' }>): boolean {
  return (
    (message.usage?.input_tokens || 0) === 0 &&
    (message.usage?.output_tokens || 0) === 0 &&
    (message.usage?.cache_creation_input_tokens || 0) === 0 &&
    (message.usage?.cache_read_input_tokens || 0) === 0
  );
}

function buildUnavailableClaudeSkillMessage(
  skillName: string,
  source: import('../shared/types').ClaudeSkillSummary['source']
): string {
  const sourceLabel =
    source === 'project'
      ? 'workspace'
      : source === 'plugin'
        ? 'plugin'
        : 'user-level';

  return [
    `\`/${skillName}\` was entered as a Claude skill, but this session did not load that ${sourceLabel} skill.`,
    '',
    'Aegis sent the prompt, but Claude initialized without the matching skill, so the command exited without producing a reply.',
    'Retry in a fresh Claude session. If it happens again, the skill list and the Claude runtime settings are out of sync.',
  ].join('\n');
}

function buildUnavailableSessionSlashMessage(commandName: string): string {
  return [
    `\`/${commandName}\` was interpreted as a slash command, but Claude did not load a matching command or skill for this session.`,
    '',
    'Use plain language instead, or pick a command or skill from the current slash menu before sending.',
  ].join('\n');
}

function detectSilentSlashCommandFailure(
  prompt: string,
  initMessage: Extract<StreamMessage, { type: 'system'; subtype: 'init' }> | null,
  resultMessage: Extract<StreamMessage, { type: 'result' }>,
  sawTurnOutput: boolean,
  cwd?: string | null
): string | null {
  if (resultMessage.subtype !== 'success' || sawTurnOutput || !isZeroTokenResult(resultMessage)) {
    return null;
  }

  const parsed = parseSlashCommand(prompt);
  if (!parsed) {
    return null;
  }

  const loadedCommands = new Set((initMessage?.slash_commands || []).map(normalizeSlashName));
  const loadedSkills = new Set((initMessage?.skills || []).map(normalizeSlashName));
  if (loadedCommands.has(parsed.name) || loadedSkills.has(parsed.name)) {
    return null;
  }

  const { userSkills, projectSkills } = listClaudeSkills(cwd ?? undefined);
  const matchingSkill = [...projectSkills, ...userSkills].find(
    (skill) => normalizeSlashName(skill.name) === parsed.name
  );
  if (matchingSkill) {
    return buildUnavailableClaudeSkillMessage(matchingSkill.name, matchingSkill.source);
  }

  return buildUnavailableSessionSlashMessage(parsed.name);
}

function extractAssistantText(message: StreamMessage): string {
  if (message.type === 'proposed_plan') {
    const planMarkdown = message.planMarkdown.trim();
    return planMarkdown ? `Proposed plan:\n${planMarkdown}` : '';
  }

  if (message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) {
    return '';
  }

  return message.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function detectLocalRunnerFailureMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }

  if (/Failed to authenticate/i.test(normalized) && /Request not allowed/i.test(normalized)) {
    return normalized;
  }

  if (/API Error:\s*403/i.test(normalized) && /Request not allowed/i.test(normalized)) {
    return normalized;
  }

  return null;
}

function isLocalUtilityAssistantText(text: string): boolean {
  return (
    text.startsWith('**Session usage**') ||
    text.startsWith('**Context compacted**') ||
    text.startsWith('Compacting conversation...') ||
    text.startsWith('Failed to compact conversation') ||
    text.includes('Aegis yet.')
  );
}

function isInvalidThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return false;
  }

  const candidate = block as { type?: unknown; signature?: unknown };
  return (
    candidate.type === 'thinking' &&
    (typeof candidate.signature !== 'string' || candidate.signature.trim().length === 0)
  );
}

function sanitizeClaudeAssistantMessage(message: StreamMessage): {
  message: StreamMessage | null;
  removedInvalidThinking: boolean;
} {
  if (message.type !== 'assistant') {
    return { message, removedInvalidThinking: false };
  }

  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { message, removedInvalidThinking: false };
  }

  let removedInvalidThinking = false;
  const nextContent = content.filter((block) => {
    const shouldKeep = !isInvalidThinkingBlock(block);
    if (!shouldKeep) {
      removedInvalidThinking = true;
    }
    return shouldKeep;
  });

  if (!removedInvalidThinking) {
    return { message, removedInvalidThinking: false };
  }

  if (nextContent.length === 0) {
    return { message: null, removedInvalidThinking: true };
  }

  return {
    message: {
      ...message,
      message: {
        ...message.message,
        content: nextContent as typeof message.message.content,
      },
    },
    removedInvalidThinking: true,
  };
}

function sanitizeClaudeHistory(messages: StreamMessage[]): {
  messages: StreamMessage[];
  hadInvalidThinking: boolean;
  changed: boolean;
} {
  let hadInvalidThinking = false;
  let changed = false;
  const nextMessages: StreamMessage[] = [];

  for (const message of messages) {
    // Subagent (Task) messages never enter rebuilt transcripts, so their
    // unsigned thinking is harmless — keep it intact for the nested traces
    // and don't let it trigger a history rewrite or session-id reset.
    if (message.parentToolUseId) {
      nextMessages.push(message);
      continue;
    }
    const sanitized = sanitizeClaudeAssistantMessage(message);
    if (sanitized.removedInvalidThinking) {
      hadInvalidThinking = true;
      changed = true;
    }
    if (sanitized.message) {
      nextMessages.push(sanitized.message);
    }
  }

  return {
    messages: changed ? nextMessages : messages,
    hadInvalidThinking,
    changed,
  };
}

function sanitizeStoredClaudeHistory(sessionId: string, messages: StreamMessage[]): {
  messages: StreamMessage[];
  hadInvalidThinking: boolean;
} {
  const sanitized = sanitizeClaudeHistory(messages);
  if (sanitized.changed) {
    sessions.replaceSessionHistory(sessionId, sanitized.messages);
    sessions.setClaudeSessionId(sessionId, null);
  }

  return {
    messages: sanitized.messages,
    hadInvalidThinking: sanitized.hadInvalidThinking,
  };
}

function buildHistoryTranscript(history: StreamMessage[]): string {
  const entries: string[] = [];

  for (const message of history) {
    // Subagent (Task) messages are internal to their Task; labeling them
    // [assistant] would corrupt rebuilt/continuation context.
    if (message.parentToolUseId) continue;
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt) {
        entries.push(`[user]\n${prompt}`);
      }
      continue;
    }

    const assistantText = extractAssistantText(message);
    if (assistantText && !isLocalUtilityAssistantText(assistantText)) {
      entries.push(`[assistant]\n${assistantText}`);
    }
  }

  return entries.join('\n\n').trim();
}

// Provider-handoff bootstrap (ported from synara's thread handoff): the first
// prompt of a handoff session carries the imported transcript — recent turns
// nearly verbatim, earlier turns as one-line bullets — inside a char budget.
const HANDOFF_RECENT_MESSAGE_COUNT = 6;
const HANDOFF_EARLIER_MESSAGE_CHAR_LIMIT = 320;
const HANDOFF_RECENT_MESSAGE_CHAR_LIMIT = 2_400;
const HANDOFF_CONTEXT_MAX_CHARS = 24_000;

function truncateHandoffText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function collectHandoffTranscriptEntries(
  history: StreamMessage[]
): Array<{ role: 'User' | 'Assistant'; text: string }> {
  const entries: Array<{ role: 'User' | 'Assistant'; text: string }> = [];
  for (const message of history) {
    if (message.parentToolUseId) continue;
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt) {
        entries.push({ role: 'User', text: prompt });
      }
      continue;
    }
    const assistantText = extractAssistantText(message);
    if (assistantText && !isLocalUtilityAssistantText(assistantText)) {
      entries.push({ role: 'Assistant', text: assistantText });
    }
  }
  return entries;
}

function buildHandoffContextText(params: {
  history: StreamMessage[];
  title: string;
  sourceProvider: string;
  maxChars?: number;
}): string | null {
  const entries = collectHandoffTranscriptEntries(params.history);
  if (entries.length === 0) {
    return null;
  }

  const earlier = entries.slice(0, -HANDOFF_RECENT_MESSAGE_COUNT);
  const recent = entries.slice(-HANDOFF_RECENT_MESSAGE_COUNT);
  const sections: string[] = [
    `This conversation was handed off from ${params.sourceProvider}. Continue the work with full awareness of the context below.`,
    `Original conversation title: ${params.title}`,
  ];

  if (earlier.length > 0) {
    sections.push(
      'Earlier conversation summary:\n' +
        earlier
          .map(
            (entry) =>
              `- ${entry.role}: ${truncateHandoffText(entry.text.replace(/\s+/g, ' ').trim(), HANDOFF_EARLIER_MESSAGE_CHAR_LIMIT)}`
          )
          .join('\n')
    );
  }

  sections.push(
    'Most recent messages:\n' +
      recent
        .map(
          (entry) => `${entry.role}:\n${truncateHandoffText(entry.text.trim(), HANDOFF_RECENT_MESSAGE_CHAR_LIMIT)}`
        )
        .join('\n\n')
  );

  const joined = sections.join('\n\n').trim();
  return truncateHandoffText(joined, Math.max(0, params.maxChars ?? HANDOFF_CONTEXT_MAX_CHARS));
}

function buildLatestEditSummaryPrompt(history: StreamMessage[]): string {
  const transcript = buildHistoryTranscript(history);
  const lines = [
    'You are helping Aegis rebuild a Claude Code conversation before the latest edited user turn.',
    'Do not continue the task. Do not ask questions. Do not use tools.',
    'Summarize the conversation state so a fresh Claude session can continue from this exact point.',
    '',
    'Preserve:',
    '- the user goal and expected deliverable',
    '- completed work and intermediate findings',
    '- important decisions, preferences, and constraints',
    '- relevant files, commands, and technical details',
    '- unresolved questions and next steps',
    '',
    'Conversation transcript:',
    transcript || '[No prior conversation context]',
    '',
    'Return only a summary wrapped in <summary></summary>.',
    'Do not include any text outside the summary tags.',
  ];

  return lines.join('\n');
}

function buildLatestEditSummaryPromptForProvider(
  providerLabel: string,
  history: StreamMessage[]
): string {
  const transcript = buildHistoryTranscript(history);
  const lines = [
    `You are helping Aegis rebuild a ${providerLabel} conversation before the latest edited user turn.`,
    'Do not continue the task. Do not ask questions. Do not use tools.',
    'Summarize the conversation state so a fresh session can continue from this exact point.',
    '',
    'Preserve:',
    '- the user goal and expected deliverable',
    '- completed work and intermediate findings',
    '- important decisions, preferences, and constraints',
    '- relevant files, commands, and technical details',
    '- unresolved questions and next steps',
    '',
    'Conversation transcript:',
    transcript || '[No prior conversation context]',
    '',
    'Return only a summary wrapped in <summary></summary>.',
    'Do not include any text outside the summary tags.',
  ];

  return lines.join('\n');
}

function buildDirectEditBootstrapPrompt(params: {
  transcript: string;
  cwd?: string | null;
}): string {
  const lines = [
    'You are resuming an Aegis Claude Code conversation after the latest user message was edited.',
    'Treat the following transcript as the conversation state immediately before the edited user turn.',
    'Absorb the context so future turns can continue naturally from this point.',
    'Do not continue the task yet. Do not ask questions. Do not use tools.',
  ];

  if (params.cwd) {
    lines.push(`Project working directory: ${params.cwd}`);
  }

  lines.push(
    '',
    'Conversation transcript:',
    params.transcript || '[No prior conversation context]',
    '',
    'Do not repeat the transcript or summarize it back.',
    'Reply with exactly READY.'
  );

  return lines.join('\n');
}

function buildDirectEditBootstrapPromptForProvider(params: {
  providerLabel: string;
  transcript: string;
  cwd?: string | null;
}): string {
  const lines = [
    `You are resuming an Aegis ${params.providerLabel} conversation after the latest user message was edited.`,
    'Treat the following transcript as the conversation state immediately before the edited user turn.',
    'Absorb the context so future turns can continue naturally from this point.',
    'Do not continue the task yet. Do not ask questions. Do not use tools.',
  ];

  if (params.cwd) {
    lines.push(`Project working directory: ${params.cwd}`);
  }

  lines.push(
    '',
    'Conversation transcript:',
    params.transcript || '[No prior conversation context]',
    '',
    'Do not repeat the transcript or summarize it back.',
    'Reply with exactly READY.'
  );

  return lines.join('\n');
}

async function bootstrapClaudeSessionFromHistory(params: {
  history: StreamMessage[];
  cwd?: string | null;
  model?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeReasoningEffort?: import('../shared/types').ClaudeReasoningEffort;
}): Promise<{ sessionId: string; model?: string | null }> {
  const transcript = buildHistoryTranscript(params.history);
  const canDirectBootstrap =
    transcript.length > 0 &&
    transcript.length <= DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS;

  const bootstrapResult = canDirectBootstrap
    ? await runClaudeOneShot({
        prompt: buildDirectEditBootstrapPrompt({
          transcript,
          cwd: params.cwd,
        }),
        cwd: params.cwd ?? undefined,
        model: params.model || undefined,
        compatibleProviderId: params.compatibleProviderId,
        betas: params.betas,
        claudeReasoningEffort: params.claudeReasoningEffort,
      })
    : await (async () => {
        const summaryResult = await runClaudeOneShot({
          prompt: buildLatestEditSummaryPrompt(params.history),
          cwd: params.cwd ?? undefined,
          model: params.model || undefined,
          compatibleProviderId: params.compatibleProviderId,
          betas: params.betas,
          claudeReasoningEffort: params.claudeReasoningEffort,
        });
        const summary = extractSummaryContent(summaryResult.text);
        if (!summary) {
          throw new Error('Claude returned an empty bootstrap summary.');
        }

        return runClaudeOneShot({
          prompt: buildCompactBootstrapPrompt({
            summary,
            cwd: params.cwd,
            recentConversation: buildRecentConversationContext(params.history),
          }),
          cwd: params.cwd ?? undefined,
          model: summaryResult.model || params.model || undefined,
          compatibleProviderId: params.compatibleProviderId,
          betas: params.betas,
          claudeReasoningEffort: params.claudeReasoningEffort,
        });
      })();

  if (!bootstrapResult.sessionId) {
    throw new Error('Claude did not return a bootstrap session id.');
  }

  return {
    sessionId: bootstrapResult.sessionId,
    model: normalizeModel(bootstrapResult.model || params.model || undefined),
  };
}

async function bootstrapCodexSessionFromHistory(params: {
  history: StreamMessage[];
  cwd?: string | null;
  model?: string | null;
  codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
  codexFastMode?: boolean;
}): Promise<{ sessionId: string; model?: string | null }> {
  const transcript = buildHistoryTranscript(params.history);
  const canDirectBootstrap =
    transcript.length > 0 &&
    transcript.length <= DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS;

  const bootstrapResult = canDirectBootstrap
    ? await runCodexOneShot({
        prompt: buildDirectEditBootstrapPromptForProvider({
          providerLabel: 'Codex',
          transcript,
          cwd: params.cwd,
        }),
        cwd: params.cwd ?? undefined,
        model: params.model || undefined,
        codexPermissionMode: params.codexPermissionMode,
        codexReasoningEffort: params.codexReasoningEffort,
        codexFastMode: params.codexFastMode,
      })
    : await (async () => {
        const summaryResult = await runCodexOneShot({
          prompt: buildLatestEditSummaryPromptForProvider('Codex', params.history),
          cwd: params.cwd ?? undefined,
          model: params.model || undefined,
          codexPermissionMode: params.codexPermissionMode,
          codexReasoningEffort: params.codexReasoningEffort,
          codexFastMode: params.codexFastMode,
        });
        const summary = extractSummaryContent(summaryResult.text);
        if (!summary) {
          throw new Error('Codex returned an empty bootstrap summary.');
        }

        return runCodexOneShot({
          prompt: buildCompactBootstrapPrompt({
            summary,
            cwd: params.cwd,
            recentConversation: buildRecentConversationContext(params.history),
          }),
          cwd: params.cwd ?? undefined,
          model: summaryResult.model || params.model || undefined,
          codexPermissionMode: params.codexPermissionMode,
          codexReasoningEffort: params.codexReasoningEffort,
          codexFastMode: params.codexFastMode,
        });
      })();

  if (!bootstrapResult.sessionId) {
    throw new Error('Codex did not return a bootstrap session id.');
  }

  return {
    sessionId: bootstrapResult.sessionId,
    model: normalizeModel(bootstrapResult.model || params.model || undefined),
  };
}

async function bootstrapOpenCodeSessionFromHistory(params: {
  history: StreamMessage[];
  cwd?: string | null;
  model?: string | null;
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
}): Promise<{ sessionId: string; model?: string | null }> {
  const transcript = buildHistoryTranscript(params.history);
  const canDirectBootstrap =
    transcript.length > 0 &&
    transcript.length <= DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS;

  const bootstrapResult = canDirectBootstrap
    ? await runOpenCodeOneShot({
        prompt: buildDirectEditBootstrapPromptForProvider({
          providerLabel: 'OpenCode',
          transcript,
          cwd: params.cwd,
        }),
        cwd: params.cwd ?? undefined,
        model: params.model || undefined,
        opencodePermissionMode: params.opencodePermissionMode,
      })
    : await (async () => {
        const summaryResult = await runOpenCodeOneShot({
          prompt: buildLatestEditSummaryPromptForProvider('OpenCode', params.history),
          cwd: params.cwd ?? undefined,
          model: params.model || undefined,
          opencodePermissionMode: params.opencodePermissionMode,
        });
        const summary = extractSummaryContent(summaryResult.text);
        if (!summary) {
          throw new Error('OpenCode returned an empty bootstrap summary.');
        }

        return runOpenCodeOneShot({
          prompt: buildCompactBootstrapPrompt({
            summary,
            cwd: params.cwd,
            recentConversation: buildRecentConversationContext(params.history),
          }),
          cwd: params.cwd ?? undefined,
          model: summaryResult.model || params.model || undefined,
          opencodePermissionMode: params.opencodePermissionMode,
        });
      })();

  if (!bootstrapResult.sessionId) {
    throw new Error('OpenCode did not return a bootstrap session id.');
  }

  return {
    sessionId: bootstrapResult.sessionId,
    model: normalizeModel(bootstrapResult.model || params.model || undefined),
  };
}

function extractSummaryContent(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match ? match[1] : text).trim();
}

function buildRecentConversationContext(history: StreamMessage[]): string {
  const recentEntries: string[] = [];

  for (let index = history.length - 1; index >= 0 && recentEntries.length < 4; index -= 1) {
    const message = history[index];
    if (message.parentToolUseId) continue;
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt && !prompt.startsWith('/')) {
        recentEntries.unshift(`[user]\n${prompt}`);
      }
      continue;
    }

    const assistantText = extractAssistantText(message);
    if (assistantText && !isLocalUtilityAssistantText(assistantText)) {
      recentEntries.unshift(`[assistant]\n${assistantText}`);
    }
  }

  return recentEntries.join('\n\n').trim();
}

function buildCompactBootstrapPrompt(params: {
  summary: string;
  cwd?: string | null;
  recentConversation?: string;
}): string {
  const lines = [
    'You are resuming an Aegis Claude Code conversation after local compaction.',
    'Adopt the following summary as the current session context and continue from it on future turns.',
  ];

  if (params.cwd) {
    lines.push(`Project working directory: ${params.cwd}`);
  }

  lines.push('', '<summary>', params.summary, '</summary>');

  if (params.recentConversation) {
    lines.push(
      '',
      'Recent verbatim turns to preserve if useful:',
      params.recentConversation
    );
  }

  lines.push(
    '',
    'Do not repeat the summary back to the user.',
    'Do not start working yet.',
    'Reply with exactly READY.'
  );

  return lines.join('\n');
}


async function handleEditLatestPrompt(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<void> {
  const {
    sessionId,
    prompt,
    attachments,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    claudeReasoningEffort,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
  } = payload;
  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  const longPromptAttachment = await maybeConvertLongPromptToAttachment({
    cwd: session.cwd,
    prompt,
    attachments,
  });
  const nextPromptText = longPromptAttachment.prompt;
  const nextAttachments = longPromptAttachment.attachments;

  if (session.provider === 'codex') {
    await handleEditLatestCodexPrompt(mainWindow, {
      sessionId,
      prompt: nextPromptText,
      attachments: nextAttachments,
      model,
      codexExecutionMode,
      codexPermissionMode,
      codexReasoningEffort,
      codexFastMode,
    }, session);
    return;
  }

  if (session.provider === 'opencode') {
    await handleEditLatestOpenCodePrompt(mainWindow, {
      sessionId,
      prompt: nextPromptText,
      attachments: nextAttachments,
      model,
      opencodePermissionMode: payload.opencodePermissionMode,
    }, session);
    return;
  }

  if (session.provider !== 'claude') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Editing the latest sent message is currently available only for Claude, Codex, and OpenCode sessions.', sessionId },
    });
    return;
  }

  const existingEntry = runnerHandles.get(sessionId);
  if (existingEntry) {
    // Abort even when idle: a kept-alive Claude runner still holds the
    // pre-edit context, and startRunner overwriting the map entry would
    // otherwise orphan its CLI process.
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  const history = sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId)).messages;
  const previousStatus = (session.status as SessionStatus) || 'completed';
  const previousClaudeSessionId = session.claude_session_id || null;
  const previousModel = session.model || null;
  const previousCompatibleProviderId = session.compatible_provider_id || null;
  const previousBetas = parseStoredBetas(session.betas);
  const previousClaudeAccessMode = normalizeClaudeAccessMode(session.claude_access_mode);
  const previousClaudeExecutionMode = normalizeClaudeExecutionMode(
    session.claude_execution_mode,
    previousClaudeAccessMode
  );
  const previousClaudeReasoningEffort = normalizeClaudeReasoningEffort(session.claude_reasoning_effort);
  let latestUserPromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.type === 'user_prompt') {
      latestUserPromptIndex = index;
      break;
    }
  }

  if (latestUserPromptIndex === -1) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'No editable user prompt found for this session.', sessionId },
    });
    return;
  }
  const previousEditablePrompt = history[latestUserPromptIndex];
  if (!previousEditablePrompt || previousEditablePrompt.type !== 'user_prompt') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to resolve the editable user prompt for this session.', sessionId },
    });
    return;
  }

  const preservedHistory = history.slice(0, latestUserPromptIndex);
  const requestedModel = normalizeModel(model ?? session.model ?? undefined);
  const requestedCompatibleProviderId =
    compatibleProviderId ?? session.compatible_provider_id ?? undefined;
  const requestedBetas = normalizeBetas(betas ?? parseStoredBetas(session.betas));
  const nextPrompt = nextPromptText.trim();
  const nextClaudeAccessMode = normalizeClaudeAccessMode(claudeAccessMode || previousClaudeAccessMode);
  const nextClaudeExecutionMode = normalizeClaudeExecutionMode(
    claudeExecutionMode || previousClaudeExecutionMode,
    nextClaudeAccessMode
  );
  const nextClaudeReasoningEffort = normalizeClaudeReasoningEffort(
    claudeReasoningEffort || previousClaudeReasoningEffort
  );
  const createdAt = Date.now();
  const editedUserPrompt: StreamMessage = {
    type: 'user_prompt',
    prompt: nextPrompt,
    attachments: nextAttachments,
    createdAt,
  };
  const rewrittenHistory = [...preservedHistory, editedUserPrompt];
  let nextClaudeSessionId: string | undefined;
  let resolvedModel = requestedModel;

  // Optimistically update the visible history before the expensive
  // summary/bootstrap round-trip so the edited prompt changes immediately.
  sessions.replaceSessionHistory(sessionId, rewrittenHistory);
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, nextPrompt);
  sessions.setClaudeSessionId(sessionId, null);
  sessions.updateSessionModel(sessionId, requestedModel || null);
  sessions.updateSessionCompatibleProviderId(sessionId, requestedCompatibleProviderId || null);
  sessions.updateSessionBetas(sessionId, requestedBetas || null);
  sessions.updateSessionClaudeAccessMode(sessionId, nextClaudeAccessMode);
  sessions.updateSessionClaudeExecutionMode(sessionId, nextClaudeExecutionMode);
  sessions.updateSessionClaudeReasoningEffort(sessionId, nextClaudeReasoningEffort);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: 'running',
      messages: rewrittenHistory,
    },
  });

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: session.provider || 'claude',
      model: requestedModel || undefined,
      compatibleProviderId: requestedCompatibleProviderId,
      betas: requestedBetas,
      claudeAccessMode: nextClaudeAccessMode,
      claudeExecutionMode: nextClaudeExecutionMode,
      claudeReasoningEffort: nextClaudeReasoningEffort,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  try {
    if (preservedHistory.length > 0) {
      const bootstrap = await bootstrapClaudeSessionFromHistory({
        history: preservedHistory,
        cwd: session.cwd,
        model: requestedModel,
        compatibleProviderId: requestedCompatibleProviderId,
        betas: requestedBetas,
        claudeReasoningEffort: nextClaudeReasoningEffort,
      });
      nextClaudeSessionId = bootstrap.sessionId;
      resolvedModel = normalizeModel(bootstrap.model || requestedModel || undefined);
    }
  } catch (error) {
    sessions.replaceSessionHistory(sessionId, history);
    sessions.updateSessionStatus(sessionId, previousStatus);
    sessions.updateLastPrompt(sessionId, previousEditablePrompt.prompt);
    sessions.setClaudeSessionId(sessionId, previousClaudeSessionId);
    sessions.updateSessionModel(sessionId, previousModel);
    sessions.updateSessionCompatibleProviderId(sessionId, previousCompatibleProviderId);
    sessions.updateSessionBetas(sessionId, previousBetas || null);
    sessions.updateSessionClaudeAccessMode(sessionId, previousClaudeAccessMode);
    sessions.updateSessionClaudeReasoningEffort(sessionId, previousClaudeReasoningEffort);
    sessions.updateSessionClaudeExecutionMode(sessionId, previousClaudeExecutionMode);

    broadcast(mainWindow, {
      type: 'session.history',
      payload: {
        sessionId,
        status: previousStatus,
        messages: history,
      },
    });

    broadcast(mainWindow, {
      type: 'session.status',
      payload: {
        sessionId,
        status: previousStatus,
        provider: session.provider || 'claude',
        model: previousModel || undefined,
        compatibleProviderId: previousCompatibleProviderId || undefined,
        betas: previousBetas,
        claudeAccessMode: previousClaudeAccessMode,
        claudeExecutionMode: previousClaudeExecutionMode,
        claudeReasoningEffort: previousClaudeReasoningEffort,
        hiddenFromThreads: session.hidden_from_threads === 1,
      },
    });

    const message = error instanceof Error ? error.message : String(error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to edit latest message: ${message}`, sessionId },
    });
    return;
  }
  sessions.setClaudeSessionId(sessionId, nextClaudeSessionId || null);
  sessions.updateSessionModel(sessionId, resolvedModel || null);
  sessions.updateSessionCompatibleProviderId(sessionId, requestedCompatibleProviderId || null);
  sessions.updateSessionBetas(sessionId, requestedBetas || null);
  sessions.updateSessionClaudeAccessMode(sessionId, nextClaudeAccessMode);
  sessions.updateSessionClaudeExecutionMode(sessionId, nextClaudeExecutionMode);
  sessions.updateSessionClaudeReasoningEffort(sessionId, nextClaudeReasoningEffort);

  const refreshedSession = sessions.getSession(sessionId);
  if (!refreshedSession) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to refresh session after editing the latest message.', sessionId },
    });
    return;
  }

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: refreshedSession.provider,
      model: resolvedModel || undefined,
      compatibleProviderId: refreshedSession.compatible_provider_id || undefined,
      betas: requestedBetas,
      claudeAccessMode: nextClaudeAccessMode,
      claudeExecutionMode: nextClaudeExecutionMode,
      claudeReasoningEffort: nextClaudeReasoningEffort,
      hiddenFromThreads: refreshedSession.hidden_from_threads === 1,
    },
  });

  startRunner(
    mainWindow,
    refreshedSession,
    nextPrompt,
    nextClaudeSessionId,
    nextAttachments,
    'claude',
    resolvedModel || undefined,
    requestedCompatibleProviderId,
    requestedBetas,
    nextClaudeAccessMode,
    nextClaudeExecutionMode,
    nextClaudeReasoningEffort
  );
}

async function handleEditLatestOpenCodePrompt(
  mainWindow: BrowserWindow,
  payload: {
    sessionId: string;
    prompt: string;
    attachments?: Attachment[];
    model?: string;
    opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
  },
  session: ReturnType<typeof sessions.getSession>
): Promise<void> {
  const { sessionId, prompt, attachments, model, opencodePermissionMode } = payload;
  if (!session) {
    return;
  }

  const existingEntry = runnerHandles.get(sessionId);
  if (existingEntry) {
    // Abort even when idle: the kept-alive service session still holds the
    // pre-edit thread, and the replacement start would otherwise race the
    // stale handle's stop under the same threadId.
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  const history = sessions.getSessionHistory(sessionId);
  const previousStatus = (session.status as SessionStatus) || 'completed';
  const previousOpenCodeSessionId = session.opencode_session_id || null;
  const previousModel = session.model || null;
  const previousOpenCodePermissionMode = normalizeOpenCodePermissionMode(session.opencode_permission_mode);
  let latestUserPromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.type === 'user_prompt') {
      latestUserPromptIndex = index;
      break;
    }
  }

  if (latestUserPromptIndex === -1) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'No editable user prompt found for this session.', sessionId },
    });
    return;
  }

  const previousEditablePrompt = history[latestUserPromptIndex];
  if (!previousEditablePrompt || previousEditablePrompt.type !== 'user_prompt') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to resolve the editable user prompt for this session.', sessionId },
    });
    return;
  }

  const preservedHistory = history.slice(0, latestUserPromptIndex);
  const requestedModel = normalizeModel(model ?? session.model ?? undefined);
  const nextPrompt = prompt.trim();
  const nextOpenCodePermissionMode = normalizeOpenCodePermissionMode(
    opencodePermissionMode || previousOpenCodePermissionMode
  );
  const createdAt = Date.now();
  const editedUserPrompt: StreamMessage = {
    type: 'user_prompt',
    prompt: nextPrompt,
    attachments,
    createdAt,
  };
  const rewrittenHistory = [...preservedHistory, editedUserPrompt];
  let nextOpenCodeSessionId: string | undefined;
  let resolvedModel = requestedModel;

  sessions.replaceSessionHistory(sessionId, rewrittenHistory);
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, nextPrompt);
  sessions.setOpencodeSessionId(sessionId, null);
  sessions.updateSessionModel(sessionId, requestedModel || null);
  sessions.updateSessionOpenCodePermissionMode(sessionId, nextOpenCodePermissionMode);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: 'running',
      messages: rewrittenHistory,
    },
  });

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: 'opencode',
      model: requestedModel || undefined,
      opencodePermissionMode: nextOpenCodePermissionMode,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  try {
    if (preservedHistory.length > 0) {
      const bootstrap = await bootstrapOpenCodeSessionFromHistory({
        history: preservedHistory,
        cwd: session.cwd,
        model: requestedModel,
        opencodePermissionMode: nextOpenCodePermissionMode,
      });
      nextOpenCodeSessionId = bootstrap.sessionId;
      resolvedModel = normalizeModel(bootstrap.model || requestedModel || undefined);
    }
  } catch (error) {
    sessions.replaceSessionHistory(sessionId, history);
    sessions.updateSessionStatus(sessionId, previousStatus);
    sessions.updateLastPrompt(sessionId, previousEditablePrompt.prompt);
    sessions.setOpencodeSessionId(sessionId, previousOpenCodeSessionId);
    sessions.updateSessionModel(sessionId, previousModel);
    sessions.updateSessionOpenCodePermissionMode(sessionId, previousOpenCodePermissionMode);

    broadcast(mainWindow, {
      type: 'session.history',
      payload: {
        sessionId,
        status: previousStatus,
        messages: history,
      },
    });

    broadcast(mainWindow, {
      type: 'session.status',
      payload: {
        sessionId,
        status: previousStatus,
        provider: session.provider || 'opencode',
        model: previousModel || undefined,
        opencodePermissionMode: previousOpenCodePermissionMode,
        hiddenFromThreads: session.hidden_from_threads === 1,
      },
    });

    const message = error instanceof Error ? error.message : String(error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to edit latest message: ${message}`, sessionId },
    });
    return;
  }

  sessions.setOpencodeSessionId(sessionId, nextOpenCodeSessionId || null);
  sessions.updateSessionModel(sessionId, resolvedModel || null);
  sessions.updateSessionOpenCodePermissionMode(sessionId, nextOpenCodePermissionMode);

  const refreshedSession = sessions.getSession(sessionId);
  if (!refreshedSession) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to refresh session after editing the latest message.', sessionId },
    });
    return;
  }

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: refreshedSession.provider,
      model: resolvedModel || undefined,
      opencodePermissionMode: nextOpenCodePermissionMode,
      hiddenFromThreads: refreshedSession.hidden_from_threads === 1,
    },
  });

  startRunner(
    mainWindow,
    refreshedSession,
    nextPrompt,
    nextOpenCodeSessionId,
    attachments,
    'opencode',
    resolvedModel || undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nextOpenCodePermissionMode
  );
}

async function handleEditLatestCodexPrompt(
  mainWindow: BrowserWindow,
  payload: {
    sessionId: string;
    prompt: string;
    attachments?: Attachment[];
    model?: string;
    codexExecutionMode?: import('../shared/types').CodexExecutionMode;
    codexPermissionMode?: import('../shared/types').CodexPermissionMode;
    codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
    codexFastMode?: boolean;
  },
  session: ReturnType<typeof sessions.getSession>
): Promise<void> {
  const {
    sessionId,
    prompt,
    attachments,
    model,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
  } = payload;
  if (!session) {
    return;
  }

  const existingEntry = runnerHandles.get(sessionId);
  if (existingEntry) {
    // Abort even when idle: the kept-alive service session still holds the
    // pre-edit thread, and the replacement start would otherwise race the
    // stale handle's stop under the same threadId.
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  const history = sessions.getSessionHistory(sessionId);
  const previousStatus = (session.status as SessionStatus) || 'completed';
  const previousCodexSessionId = session.codex_session_id || null;
  const previousModel = session.model || null;
  const previousCodexExecutionMode = normalizeCodexExecutionMode(session.codex_execution_mode);
  const previousCodexPermissionMode = normalizeCodexPermissionMode(session.codex_permission_mode);
  const previousCodexReasoningEffort = normalizeCodexReasoningEffort(session.codex_reasoning_effort);
  const previousCodexFastMode = normalizeCodexFastMode(session.codex_fast_mode);
  let latestUserPromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.type === 'user_prompt') {
      latestUserPromptIndex = index;
      break;
    }
  }

  if (latestUserPromptIndex === -1) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'No editable user prompt found for this session.', sessionId },
    });
    return;
  }

  const previousEditablePrompt = history[latestUserPromptIndex];
  if (!previousEditablePrompt || previousEditablePrompt.type !== 'user_prompt') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to resolve the editable user prompt for this session.', sessionId },
    });
    return;
  }

  const preservedHistory = history.slice(0, latestUserPromptIndex);
  const requestedModel = normalizeModel(model ?? session.model ?? undefined);
  const nextPrompt = prompt.trim();
  const nextCodexExecutionMode = normalizeCodexExecutionMode(
    codexExecutionMode || previousCodexExecutionMode
  );
  const nextCodexPermissionMode = normalizeCodexPermissionMode(
    codexPermissionMode || previousCodexPermissionMode
  );
  const nextCodexReasoningEffort = normalizeCodexReasoningEffort(
    codexReasoningEffort || previousCodexReasoningEffort
  );
  const nextCodexFastMode = normalizeCodexFastMode(codexFastMode ?? previousCodexFastMode);
  const createdAt = Date.now();
  const editedUserPrompt: StreamMessage = {
    type: 'user_prompt',
    prompt: nextPrompt,
    attachments,
    createdAt,
  };
  const rewrittenHistory = [...preservedHistory, editedUserPrompt];
  let nextCodexSessionId: string | undefined;
  let resolvedModel = requestedModel;

  sessions.replaceSessionHistory(sessionId, rewrittenHistory);
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, nextPrompt);
  sessions.setCodexSessionId(sessionId, null);
  sessions.updateSessionModel(sessionId, requestedModel || null);
  sessions.updateSessionCodexExecutionMode(sessionId, nextCodexExecutionMode);
  sessions.updateSessionCodexPermissionMode(sessionId, nextCodexPermissionMode);
  sessions.updateSessionCodexReasoningEffort(sessionId, nextCodexReasoningEffort || null);
  sessions.updateSessionCodexFastMode(sessionId, nextCodexFastMode);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: 'running',
      messages: rewrittenHistory,
    },
  });

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: 'codex',
      model: requestedModel || undefined,
      codexExecutionMode: nextCodexExecutionMode,
      codexPermissionMode: nextCodexPermissionMode,
      codexReasoningEffort: nextCodexReasoningEffort,
      codexFastMode: nextCodexFastMode,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  try {
    if (preservedHistory.length > 0) {
      const bootstrap = await bootstrapCodexSessionFromHistory({
        history: preservedHistory,
        cwd: session.cwd,
        model: requestedModel,
        codexPermissionMode: nextCodexPermissionMode,
        codexReasoningEffort: nextCodexReasoningEffort,
        codexFastMode: nextCodexFastMode,
      });
      nextCodexSessionId = bootstrap.sessionId;
      resolvedModel = normalizeModel(bootstrap.model || requestedModel || undefined);
    }
  } catch (error) {
    sessions.replaceSessionHistory(sessionId, history);
    sessions.updateSessionStatus(sessionId, previousStatus);
    sessions.updateLastPrompt(sessionId, previousEditablePrompt.prompt);
    sessions.setCodexSessionId(sessionId, previousCodexSessionId);
    sessions.updateSessionModel(sessionId, previousModel);
    sessions.updateSessionCodexExecutionMode(sessionId, previousCodexExecutionMode);
    sessions.updateSessionCodexPermissionMode(sessionId, previousCodexPermissionMode);
    sessions.updateSessionCodexReasoningEffort(sessionId, previousCodexReasoningEffort || null);
    sessions.updateSessionCodexFastMode(sessionId, previousCodexFastMode);

    broadcast(mainWindow, {
      type: 'session.history',
      payload: {
        sessionId,
        status: previousStatus,
        messages: history,
      },
    });

    broadcast(mainWindow, {
      type: 'session.status',
      payload: {
        sessionId,
        status: previousStatus,
        provider: session.provider || 'codex',
        model: previousModel || undefined,
        codexExecutionMode: previousCodexExecutionMode,
        codexPermissionMode: previousCodexPermissionMode,
        codexReasoningEffort: previousCodexReasoningEffort,
        codexFastMode: previousCodexFastMode,
        hiddenFromThreads: session.hidden_from_threads === 1,
      },
    });

    const message = error instanceof Error ? error.message : String(error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to edit latest message: ${message}`, sessionId },
    });
    return;
  }

  sessions.setCodexSessionId(sessionId, nextCodexSessionId || null);
  sessions.updateSessionModel(sessionId, resolvedModel || null);
  sessions.updateSessionCodexExecutionMode(sessionId, nextCodexExecutionMode);
  sessions.updateSessionCodexPermissionMode(sessionId, nextCodexPermissionMode);
  sessions.updateSessionCodexReasoningEffort(sessionId, nextCodexReasoningEffort || null);
  sessions.updateSessionCodexFastMode(sessionId, nextCodexFastMode);

  const refreshedSession = sessions.getSession(sessionId);
  if (!refreshedSession) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to refresh session after editing the latest message.', sessionId },
    });
    return;
  }

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: refreshedSession.provider,
      model: resolvedModel || undefined,
      codexExecutionMode: nextCodexExecutionMode,
      codexPermissionMode: nextCodexPermissionMode,
      codexReasoningEffort: nextCodexReasoningEffort,
      codexFastMode: nextCodexFastMode,
      hiddenFromThreads: refreshedSession.hidden_from_threads === 1,
    },
  });

  startRunner(
    mainWindow,
    refreshedSession,
    nextPrompt,
    nextCodexSessionId,
    attachments,
    'codex',
    resolvedModel || undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    nextCodexExecutionMode,
    nextCodexPermissionMode,
    nextCodexReasoningEffort || undefined,
    nextCodexFastMode,
    undefined
  );
}

async function maybeHandleLocalSlashCommand(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  attachments?: Attachment[]
): Promise<boolean> {
  if (!session) return false;

  const parsed = parseSlashCommand(prompt);
  if (!parsed) return false;

  let responseText: string | null = null;

  if (parsed.name === 'cost') {
    responseText = buildSessionCostSummary(session);
  } else if (parsed.name === 'plan') {
    responseText = buildUnsupportedSlashCommandMessage(parsed.name);
  }

  if (!responseText) {
    return false;
  }

  const createdAt = Date.now();
  sessions.updateLastPrompt(session.id, prompt);

  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt, attachments, createdAt },
  });
  sessions.addMessage(session.id, { type: 'user_prompt', prompt, attachments, createdAt });

  const assistantMessage = buildLocalAssistantMessage(responseText);
  sessions.addMessage(session.id, assistantMessage);
  broadcast(mainWindow, {
    type: 'stream.message',
    payload: { sessionId: session.id, message: assistantMessage },
  });

  return true;
}

function toAttachment(filePath: string): Attachment | null {
  const spec = getAttachmentSpec(filePath);
  if (!spec) {
    return null;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return null;
    }

    return {
      id: uuidv4(),
      path: filePath,
      name: basename(filePath),
      size: stat.size,
      mimeType: spec.mimeType,
      kind: spec.kind,
    };
  } catch {
    return null;
  }
}

async function toProjectAttachment(cwd: string, filePath: string): Promise<Attachment | null> {
  const resolved = resolve(cwd || '.', filePath || '');
  const validation = await validateProjectFilePath(cwd, resolved);
  if (!validation.ok) {
    return null;
  }

  try {
    const stat = await fsPromises.stat(validation.targetReal);
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
      return null;
    }

    const ext = extname(validation.targetReal).toLowerCase();
    const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg';

    return {
      id: uuidv4(),
      path: validation.targetReal,
      name: basename(validation.targetReal),
      size: stat.size,
      mimeType: ATTACHMENT_MIME_TYPES[ext] || (isImage ? 'image/png' : 'application/octet-stream'),
      kind: isImage ? 'image' : 'file',
    };
  } catch {
    return null;
  }
}

async function createInlineImageAttachment(
  mimeType: string,
  data: Uint8Array | ArrayBuffer | Buffer
): Promise<Attachment | null> {
  const normalizedMime = (mimeType || '').toLowerCase();
  let ext: string;
  if (normalizedMime === 'image/png') {
    ext = '.png';
  } else if (normalizedMime === 'image/jpeg' || normalizedMime === 'image/jpg') {
    ext = '.jpg';
  } else {
    return null;
  }

  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof Uint8Array) {
    buffer = Buffer.from(data);
  } else if (data instanceof ArrayBuffer) {
    buffer = Buffer.from(new Uint8Array(data));
  } else {
    return null;
  }

  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) {
    return null;
  }

  const baseDir = resolve(app.getPath('temp'), 'aegis-pasted-images');
  const fileName = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const targetPath = resolve(baseDir, fileName);

  try {
    await fsPromises.mkdir(baseDir, { recursive: true });
    await fsPromises.writeFile(targetPath, buffer);
  } catch {
    return null;
  }

  return toAttachment(targetPath);
}

async function createInlineTextAttachment(cwd: string, text: string): Promise<Attachment | null> {
  const normalizedCwd = cwd?.trim();
  const normalizedText = text ?? '';
  if (!normalizedCwd || !normalizedText.trim()) {
    return null;
  }
  if (Buffer.byteLength(normalizedText, 'utf8') > MAX_ATTACHMENT_BYTES) {
    return null;
  }

  const attachmentsDir = resolve(app.getPath('temp'), 'aegis-pasted-text');
  const fileName = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const targetPath = resolve(attachmentsDir, fileName);

  try {
    await fsPromises.mkdir(attachmentsDir, { recursive: true });
    await fsPromises.writeFile(targetPath, normalizedText, 'utf8');
    const attachment = toAttachment(targetPath);
    if (!attachment) {
      return null;
    }

    return {
      ...attachment,
      uiType: 'pasted_text',
      previewText: normalizedText,
    };
  } catch {
    return null;
  }
}

async function maybeConvertLongPromptToAttachment(params: {
  cwd?: string | null;
  prompt: string;
  attachments?: Attachment[];
}): Promise<{
  prompt: string;
  attachments: Attachment[];
  converted: boolean;
}> {
  const prompt = params.prompt.trim();
  const attachments = params.attachments?.filter((attachment) => !!attachment?.path) || [];
  if (!prompt || prompt.length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) {
    return {
      prompt,
      attachments,
      converted: false,
    };
  }

  const cwd = params.cwd?.trim();
  if (!cwd) {
    console.warn('[Long Prompt Attachment] Missing cwd; sending inline prompt instead.');
    return {
      prompt,
      attachments,
      converted: false,
    };
  }

  const attachment = await createInlineTextAttachment(cwd, prompt);
  if (!attachment) {
    console.warn('[Long Prompt Attachment] Failed to create attachment; sending inline prompt instead.', {
      cwd,
      promptLength: prompt.length,
    });
    return {
      prompt,
      attachments,
      converted: false,
    };
  }

  return {
    prompt: LONG_PROMPT_ATTACHMENT_INSTRUCTION,
    attachments: [...attachments, attachment],
    converted: true,
  };
}

// Runner 句柄映射（带 Provider）
const runnerHandles = new Map<
  string,
  {
    handle: RunnerHandle;
    provider: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi';
    compatibleProviderId?: import('../shared/types').ClaudeCompatibleProviderId;
    claudeAccessMode?: import('../shared/types').ClaudeAccessMode;
    claudeExecutionMode?: import('../shared/types').ClaudeExecutionMode;
    claudeReasoningEffort?: import('../shared/types').ClaudeReasoningEffort;
    codexExecutionMode?: import('../shared/types').CodexExecutionMode;
    codexPermissionMode?: import('../shared/types').CodexPermissionMode;
	    codexReasoningEffort?: import('../shared/types').CodexReasoningEffort;
	    codexFastMode?: boolean;
	    kimiPermissionMode?: import('../shared/types').KimiPermissionMode;
	    grokPermissionMode?: import('../shared/types').GrokPermissionMode;
	    grokReasoningEffort?: import('../shared/types').GrokReasoningEffort;
	    opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode;
    activeAgentId?: string | null;
    activeAgentRunId?: string | null;
    onTurnDone?: (status: SessionStatus, message?: string) => void;
    /** Turns dispatched into this runner that have not yet produced a `result`. */
    inFlightTurns?: number;
    /** Wall-clock time of the latest `result` — the idle anchor for the reaper. */
    lastTurnEndedAt?: number;
    /** Live context is stale or poisoned; abort at the next `result` instead of reusing. */
    doomed?: boolean;
    /** Automation runners auto-approve permissions; never reuse them for human turns. */
    autoApprove?: boolean;
    /**
     * Spawned speculatively before any user prompt (P3 prewarm). Cleared on
     * the first real dispatch. Prewarmed entries are evicted first by the
     * idle reaper's cap pass so they never displace a runner with real
     * conversation context.
     */
    prewarmed?: boolean;
    /**
     * Prompts dispatched into this runner whose `result` has not arrived yet
     * (FIFO — results come back in dispatch order on the single CLI stream).
     * Feeds the slash-command failure check for the turn each result closes;
     * a single shared slot would misattribute queued prompts. Kept aligned
     * with inFlightTurns: every result shifts one entry (stopped and
     * suppressed results included), and prompts cancelled before dispatch
     * are trimmed from the tail alongside their in-flight count.
     */
    pendingTurnPrompts?: string[];
    /**
     * User-stopped (interrupted) turns whose `result` has not landed yet.
     * Their results must report 'idle' (not error), must not trigger failure
     * detection, and — with a follow-up turn in flight — must not clobber the
     * live turn's status. Always ≤ inFlightTurns; see claude-stop-reconcile.
     */
    stoppedTurns?: number;
    /** Hard-abort fallback in case an interrupted turn's result never lands. */
    stopFallbackTimer?: NodeJS.Timeout;
    /** How many times the fallback fired for the current unreconciled stop. */
    stopFallbackAttempts?: number;
    /** Working directory the runner was spawned with — reuse must match it. */
    cwd?: string | null;
  }
>();

let automationScheduler: AutomationScheduler | null = null;

type RunnerEntry = NonNullable<ReturnType<typeof runnerHandles.get>>;

/**
 * Handles the user pressed stop on. A stopped runner can be replaced before
 * its stream finishes tearing down (e.g. a follow-up that cannot reuse it);
 * the replaced handle's late onError is then teardown noise that must never
 * mark the session — now owned by a different runner — as failed.
 */
const userStoppedRunnerHandles = new WeakSet<object>();

// Codex two-phase stop windows (P0-6): sessionId → the stop-initiating handle
// and the settle promise. While present: streaming deltas freeze, the
// interrupted turn's result writes no status, and follow-up sends hold until
// settle. Never persisted — 'stopping' is a broadcast-only status.
const stoppingCodexSessions = new Map<
  string,
  { handle: RunnerHandle; settlePromise: Promise<{ confirmed: boolean }> }
>();

/** The entry's stop bookkeeping as the pure reconcile policy consumes it. */
function stopStateOf(entry: RunnerEntry): StopStateSnapshot {
  return {
    inFlightTurns: entry.inFlightTurns ?? 0,
    stoppedTurns: entry.stoppedTurns ?? 0,
  };
}

/**
 * Drop the soft-stop hard-abort fallback. Must run whenever an entry is
 * aborted/deleted through any path so no stale timer outlives its runner.
 */
function clearStopFallbackTimer(entry: RunnerEntry): void {
  if (entry.stopFallbackTimer) {
    clearTimeout(entry.stopFallbackTimer);
    entry.stopFallbackTimer = undefined;
  }
}

// 会话状态映射（包含 pending permissions）
const sessionStates = new Map<string, SessionState>();

// ── Claude runner pool ───────────────────────────────────────────────────────
// Claude runners stay alive between turns (streaming-input reuse) so follow-up
// messages skip the CLI cold start + resume replay. Idle runners are reaped on
// a timer per the policy in claude-runner-pool.ts.

const CLAUDE_RUNNER_REAP_INTERVAL_MS = 60_000;
let claudeRunnerReapTimer: NodeJS.Timeout | null = null;

function snapshotClaudeRunners(): ClaudeRunnerSnapshot[] {
  const snapshots: ClaudeRunnerSnapshot[] = [];
  for (const [sessionId, entry] of runnerHandles) {
    if (entry.provider !== 'claude') continue;
    snapshots.push({
      sessionId,
      inFlightTurns: entry.inFlightTurns ?? 0,
      lastTurnEndedAt: entry.lastTurnEndedAt,
      hasPendingPermissions:
        (sessionStates.get(sessionId)?.pendingPermissions.size ?? 0) > 0,
      prewarmed: entry.prewarmed === true,
    });
  }
  return snapshots;
}

function sweepIdleClaudeRunners(): void {
  const victims = selectClaudeRunnersToReap(snapshotClaudeRunners(), Date.now());
  for (const sessionId of victims) {
    const entry = runnerHandles.get(sessionId);
    // Re-check liveness: a turn may have been dispatched since the snapshot.
    if (!entry || entry.provider !== 'claude' || (entry.inFlightTurns ?? 0) > 0) continue;
    entry.handle.abort();
    runnerHandles.delete(sessionId);
  }
}

function ensureClaudeRunnerReaper(): void {
  if (claudeRunnerReapTimer) return;
  claudeRunnerReapTimer = setInterval(sweepIdleClaudeRunners, CLAUDE_RUNNER_REAP_INTERVAL_MS);
  claudeRunnerReapTimer.unref?.();
}

function stopClaudeRunnerReaper(): void {
  if (claudeRunnerReapTimer) {
    clearInterval(claudeRunnerReapTimer);
    claudeRunnerReapTimer = null;
  }
}

/**
 * Config/workspace changes invalidate the environment a live runner captured
 * at spawn (API keys, compatible-provider endpoints, MCP servers, cwd). Idle
 * runners are killed immediately; busy ones are doomed and reaped at their
 * next `result` so they can never serve another turn with stale state.
 */
function flushClaudeRunners(sessionId?: string): void {
  for (const [id, entry] of runnerHandles) {
    if (entry.provider !== 'claude') continue;
    if (sessionId && id !== sessionId) continue;
    if ((entry.inFlightTurns ?? 0) > 0) {
      entry.doomed = true;
    } else {
      entry.handle.abort();
      runnerHandles.delete(id);
    }
  }
}

/**
 * Retire a session's kept-alive runner regardless of provider. Every provider
 * keeps its handle between turns (connection reuse) and every live session is
 * bound to the cwd it started with, so a workspace change (handoff, worktree
 * move) must drop the handle for ALL providers — flushing only Claude would
 * let a Codex/OpenCode/Kimi/Grok/Pi runner serve the next turn against the
 * old checkout. Callers gate on DB status, so the handle is idle; a Claude
 * runner with an in-flight turn (defensive) is doomed like flushClaudeRunners.
 */
function retireSessionRunner(sessionId: string): void {
  const entry = runnerHandles.get(sessionId);
  if (!entry) return;
  if (entry.provider === 'claude' && (entry.inFlightTurns ?? 0) > 0) {
    entry.doomed = true;
    return;
  }
  clearStopFallbackTimer(entry);
  entry.handle.abort();
  runnerHandles.delete(sessionId);
}

function isPathAtOrUnder(child: string, root: string): boolean {
  try {
    const rel = relative(resolve(root), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Retire every kept-alive runner (any provider, any session) anchored at or
 * inside `dirPath`. Used when a directory runners spawned in is deleted —
 * worktree apply/discard force-remove the checkout even when sibling sessions
 * still point at it — so a live process would otherwise linger on a dead cwd.
 * Runners of RUNNING sessions are never touched: aborting one mid-turn would
 * strand the session as 'running' with no terminal event. Callers block on
 * running siblings up front; this guard covers races.
 */
function retireRunnersUnderPath(dirPath: string): void {
  for (const [sessionId, entry] of Array.from(runnerHandles.entries())) {
    if (!entry.cwd || !isPathAtOrUnder(entry.cwd, dirPath)) continue;
    if (sessions.getSession(sessionId)?.status === 'running') continue;
    retireSessionRunner(sessionId);
  }
}

/**
 * A RUNNING session (other than `excludedSessionId`) whose checkout sits at
 * or under `dirPath`, or null. Deleting a directory under a running agent
 * corrupts its turn — callers must block the operation instead.
 */
function findRunningSessionUnderPath(
  dirPath: string,
  excludedSessionId?: string | null
): NonNullable<ReturnType<typeof sessions.getSession>> | null {
  for (const row of sessions.listRunningSessions()) {
    if (excludedSessionId && row.id === excludedSessionId) continue;
    const rowCwd = row.worktree_path || row.cwd;
    if (rowCwd && isPathAtOrUnder(rowCwd, dirPath)) return row;
  }
  return null;
}

/**
 * The working directory a runner for this session would spawn with — the
 * same fallback startRunner applies for DM sessions. Reuse decisions compare
 * against this so a session whose workspace moved never reuses a live runner
 * bound to the old checkout.
 */
function effectiveRunnerCwd(
  session: NonNullable<ReturnType<typeof sessions.getSession>>
): string | null {
  if (session.conversation_scope === 'dm' && !session.cwd) {
    return getDirectMessageRuntimeCwd();
  }
  return session.cwd || null;
}

// 获取或创建会话状态
function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = { pendingPermissions: new Map() };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// 广播事件到渲染进程
function broadcast(mainWindow: BrowserWindow, event: ServerEvent): void {
  // 检查窗口和 webContents 是否已销毁
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('server-event', JSON.stringify(event));
}

function getAutomationSnapshot() {
  return {
    automations: sessions.listAutomations(),
    recentRuns: sessions.listAutomationRuns({ limit: 100 }),
  };
}

function broadcastAutomationChanged(mainWindow: BrowserWindow): void {
  broadcast(mainWindow, {
    type: 'automation.changed',
    payload: getAutomationSnapshot(),
  });
}

// worktree ↔ local 切换后同步 renderer 的 workspace 字段（cwd/envMode/worktree*）
function broadcastSessionWorkspace(mainWindow: BrowserWindow, sessionId: string): void {
  const row = sessions.getSession(sessionId);
  if (!row) return;
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: (row.status || 'idle') as SessionStatus,
      cwd: row.cwd || undefined,
      projectCwd: row.project_cwd || row.cwd || null,
      envMode: row.env_mode === 'worktree' ? 'worktree' : 'local',
      worktreePath: row.worktree_path || null,
      associatedWorktreePath: row.associated_worktree_path || null,
      associatedWorktreeBranch: row.associated_worktree_branch || null,
      associatedWorktreeRef: row.associated_worktree_ref || null,
      hiddenFromThreads: row.hidden_from_threads === 1,
    },
  });
}

async function emitProjectTree(mainWindow: BrowserWindow, cwd: string, scheduledVersion: number): Promise<void> {
  try {
    const tree = await readProjectTree(cwd);
    if (!projectWatchers.has(cwd) || getProjectTreeVersion(cwd) !== scheduledVersion) {
      return;
    }
    if (!tree) {
      closeProjectTreeWatcher(cwd);
      broadcast(mainWindow, { type: 'project.tree', payload: { cwd, tree: null } });
      return;
    }
    broadcast(mainWindow, { type: 'project.tree', payload: { cwd, tree } });
  } catch (error) {
    console.error('Failed to read project tree:', error);
    if (!projectWatchers.has(cwd) || getProjectTreeVersion(cwd) !== scheduledVersion) {
      return;
    }
    closeProjectTreeWatcher(cwd);
    broadcast(mainWindow, { type: 'project.tree', payload: { cwd, tree: null } });
  }
}

function scheduleProjectTree(mainWindow: BrowserWindow, cwd: string): void {
  const entry = projectWatchers.get(cwd);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  const scheduledVersion = getProjectTreeVersion(cwd);
  entry.timer = setTimeout(() => {
    void emitProjectTree(mainWindow, cwd, scheduledVersion);
  }, PROJECT_TREE_REFRESH_DELAY_MS);
}

async function emitProjectFile(
  mainWindow: BrowserWindow,
  cwd: string,
  filePath: string
): Promise<void> {
  const resolved = resolve(cwd || '.', filePath || '');
  try {
    const stat = await fsPromises.stat(resolved);
    if (!stat.isFile()) return;
    const text = await fsPromises.readFile(resolved, 'utf8');
    broadcast(mainWindow, {
      type: 'project.file',
      payload: { cwd, filePath, text, mtimeMs: stat.mtimeMs, size: stat.size, exists: true },
    });
  } catch {
    broadcast(mainWindow, {
      type: 'project.file',
      payload: { cwd, filePath, text: '', mtimeMs: 0, size: 0, exists: false },
    });
  }
}

function scheduleProjectFile(mainWindow: BrowserWindow, key: string): void {
  const entry = projectFileWatchers.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    emitProjectFile(mainWindow, entry.cwd, entry.filePath);
  }, 150);
}

function mapGitChangeStatus(indexStatus: string, workStatus: string): {
  status: 'M' | 'A' | 'D' | 'R' | '?';
  staged: boolean;
} {
  if (indexStatus === '?' && workStatus === '?') {
    return { status: '?', staged: false };
  }

  // Prefer the worktree state when present so mixed porcelain states like AM/RM
  // still surface as modified in the Changes panel.
  if (workStatus === 'D') {
    return { status: 'D', staged: false };
  }
  if (workStatus === 'R') {
    return { status: 'R', staged: false };
  }
  if (workStatus === 'M') {
    return { status: 'M', staged: false };
  }

  if (indexStatus === 'D') {
    return { status: 'D', staged: workStatus === ' ' };
  }
  if (indexStatus === 'R') {
    return { status: 'R', staged: workStatus === ' ' };
  }
  if (indexStatus === 'M') {
    return { status: 'M', staged: workStatus === ' ' };
  }
  if (indexStatus === 'A') {
    return { status: 'A', staged: workStatus === ' ' };
  }

  return { status: 'M', staged: false };
}

function parseGitStatusEntries(stdout: string): Array<{ filePath: string; status: string; staged: boolean }> {
  const entries: Array<{ filePath: string; status: string; staged: boolean }> = [];
  const records = stdout.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const indexStatus = record[0];
    const workStatus = record[1];
    const filePath = record.slice(3);
    if (!filePath) continue;

    const { status, staged } = mapGitChangeStatus(indexStatus, workStatus);
    entries.push({ filePath, status, staged });

    if (indexStatus === 'R' || indexStatus === 'C' || workStatus === 'R' || workStatus === 'C') {
      index += 1;
    }
  }

  return entries;
}

const execFileAsync = promisify(execFile);
const GIT_PATCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const GIT_PATCH_MAX_CHARS = 8 * 1024 * 1024;

// ── "Open with" (macOS Launch Services) ─────────────────────────────────────

interface OpenWithApp {
  name: string;
  appPath: string;
  iconDataUrl: string | null;
}

// App icons are stable per bundle path; cache the data URLs so repeated
// dropdown opens don't re-decode .icns files.
const openWithIconCache = new Map<string, string | null>();

// Query Launch Services for every app that can open `targetPath`, default
// first. For text-like files a second query against a plain-text probe file
// separates real editors from extension-collision handlers (see
// open-with-ranking.ts). URLsForApplicationsToOpenURL requires macOS 12+; on
// older systems the JXA throws and the caller degrades to an empty list. The
// paths are passed via argv ($.NSProcessInfo arguments), never interpolated
// into the script.
async function queryLaunchServicesApps(
  targetPath: string
): Promise<{ fileApps: string[]; textApps: string[] }> {
  const script = `
    ObjC.import('AppKit');
    function run(argv) {
      const ws = $.NSWorkspace.sharedWorkspace;
      const collect = (path, includeDefault) => {
        if (!path) return [];
        const url = $.NSURL.fileURLWithPath(path);
        const ordered = [];
        const seen = {};
        const push = (p) => { if (p && !seen[p]) { seen[p] = true; ordered.push(p); } };
        if (includeDefault) {
          const def = ws.URLForApplicationToOpenURL(url);
          if (def && !def.isNil()) push(def.path.js);
        }
        const arr = ws.URLsForApplicationsToOpenURL(url);
        if (arr && !arr.isNil()) {
          for (let i = 0; i < arr.count; i++) push(arr.objectAtIndex(i).path.js);
        }
        return ordered;
      };
      return JSON.stringify({
        fileApps: collect(argv[0], true),
        textApps: collect(argv[1], false),
      });
    }
  `;

  let probePath = '';
  if (isTextLikeForOpenWith(targetPath)) {
    probePath = join(tmpdir(), 'aegis-open-with-probe.txt');
    try {
      await fsPromises.writeFile(probePath, '', { flag: 'wx' });
    } catch {
      // Already exists (or unwritable — the query then degrades gracefully).
    }
  }

  const { stdout } = await execFileAsync(
    'osascript',
    ['-l', 'JavaScript', '-e', script, targetPath, probePath],
    { timeout: 5000, maxBuffer: 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout.trim() || '{}') as {
    fileApps?: unknown;
    textApps?: unknown;
  };
  const asPaths = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((p): p is string => typeof p === 'string' && !!p)
      : [];
  return { fileApps: asPaths(parsed.fileApps), textApps: asPaths(parsed.textApps) };
}

// Electron's app.getFileIcon resolves icons by file EXTENSION, so on macOS
// every .app bundle yields the same generic icon. Render the real per-app
// icons through NSWorkspace.iconForFile instead — one osascript call extracts
// the whole batch as 32pt PNGs (covers .icns and Assets.car apps alike).
async function extractAppIconDataUrls(appPaths: string[]): Promise<void> {
  const pending = appPaths.filter((appPath) => !openWithIconCache.has(appPath));
  if (pending.length === 0) return;

  const script = `
    ObjC.import('AppKit');
    function run(argv) {
      const outDir = argv[0];
      const written = [];
      for (let i = 1; i < argv.length; i++) {
        let out = null;
        try {
          const img = $.NSWorkspace.sharedWorkspace.iconForFile(argv[i]);
          const small = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
          small.lockFocus;
          img.drawInRectFromRectOperationFraction(
            $.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
          small.unlockFocus;
          const rep = $.NSBitmapImageRep.imageRepWithData(small.TIFFRepresentation);
          const png = rep.representationUsingTypeProperties(4 /* PNG */, $.NSDictionary.dictionary);
          const file = outDir + '/' + (i - 1) + '.png';
          if (png && !png.isNil() && png.writeToFileAtomically(file, true)) out = file;
        } catch (e) { out = null; }
        written.push(out);
      }
      return JSON.stringify(written);
    }
  `;

  let outDir: string | null = null;
  let files: (string | null)[] = [];
  try {
    outDir = await fsPromises.mkdtemp(join(tmpdir(), 'aegis-open-with-'));
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', script, outDir, ...pending],
      { timeout: 10000, maxBuffer: 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout.trim() || '[]');
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    files = [];
  }

  try {
    await Promise.all(
      pending.map(async (appPath, i) => {
        let dataUrl: string | null = null;
        const file = typeof files[i] === 'string' ? files[i] : null;
        if (file) {
          try {
            const png = await fsPromises.readFile(file);
            dataUrl = `data:image/png;base64,${png.toString('base64')}`;
          } catch {
            dataUrl = null;
          }
        }
        if (!dataUrl) {
          // Fallback: .icns extraction via sips (misses Assets.car-only apps).
          dataUrl = (await getNativeIconDataUrl(appPath)) ?? null;
        }
        openWithIconCache.set(appPath, dataUrl);
      })
    );
  } finally {
    if (outDir) {
      void fsPromises.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// The dropdown shows at most a handful of apps; don't extract icons for the
// long tail Launch Services returns.
const OPEN_WITH_APP_LIMIT = 8;

async function listOpenWithApps(targetPath: string): Promise<OpenWithApp[]> {
  const { fileApps, textApps } = await queryLaunchServicesApps(targetPath);
  const appPaths = rankOpenWithAppPaths({ fileApps, textApps, limit: OPEN_WITH_APP_LIMIT });
  await extractAppIconDataUrls(appPaths);
  return appPaths.map((appPath) => ({
    name: openWithDisplayName(appPath),
    appPath,
    iconDataUrl: openWithIconCache.get(appPath) ?? null,
  }));
}

function parseGitNumstat(stdout: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [addedRaw, removedRaw] = trimmed.split('\t');
    const added = Number(addedRaw);
    const removed = Number(removedRaw);

    if (Number.isFinite(added)) {
      insertions += added;
    }
    if (Number.isFinite(removed)) {
      deletions += removed;
    }
  }

  return { insertions, deletions };
}

function normalizeGitPatchScope(value: unknown): GitPatchScope {
  if (
    value === 'working-tree' ||
    value === 'unstaged' ||
    value === 'staged' ||
    value === 'branch'
  ) {
    return value;
  }
  return 'working-tree';
}

function getExecStdout(error: unknown): string {
  if (error && typeof error === 'object' && 'stdout' in error) {
    return String((error as { stdout?: unknown }).stdout ?? '');
  }
  return '';
}

function normalizePatchResult(
  scope: GitPatchScope,
  patch: string,
  repoRoot: string | null,
  baseRef?: string | null
): GitPatchResult {
  const truncated = patch.length > GIT_PATCH_MAX_CHARS;
  return {
    ok: true,
    error: null,
    scope,
    patch: truncated
      ? `${patch.slice(0, GIT_PATCH_MAX_CHARS)}\n\ndiff --git a/.aegis-truncated b/.aegis-truncated\n--- a/.aegis-truncated\n+++ b/.aegis-truncated\n@@ -1 +1 @@\n-Patch truncated.\n+Patch truncated. Narrow the review scope to inspect the remaining changes.\n`
      : patch,
    repoRoot,
    baseRef,
    truncated,
  };
}

async function runGitDiff(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--unified=3', ...args],
    {
      cwd,
      timeout: 15000,
      maxBuffer: GIT_PATCH_MAX_BUFFER_BYTES,
    }
  );
  return stdout;
}

async function getUntrackedPatch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
    {
      cwd,
      timeout: 10000,
      maxBuffer: GIT_PATCH_MAX_BUFFER_BYTES,
    }
  );
  const untrackedPaths = stdout.split('\0').map((item) => item.trim()).filter(Boolean);
  const patches: string[] = [];

  for (const filePath of untrackedPaths) {
    try {
      const { stdout: patch } = await execFileAsync(
        'git',
        [
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-index',
          '--no-color',
          '--unified=3',
          '--',
          '/dev/null',
          filePath,
        ],
        {
          cwd,
          timeout: 10000,
          maxBuffer: GIT_PATCH_MAX_BUFFER_BYTES,
        }
      );
      if (patch.trim()) patches.push(patch);
    } catch (error) {
      const patch = getExecStdout(error);
      if (patch.trim()) patches.push(patch);
    }
  }

  return patches.join('\n');
}

function humanizeCommitTarget(value: string): string {
  return value
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(ui|ipc|api|pr|md|tsx?|jsx?)\b/gi, (match) => match.toUpperCase())
    .toLowerCase()
    .trim();
}

function inferCommitTarget(files: string[], diffText: string): string {
  const haystack = `${files.join('\n')}\n${diffText}`.toLowerCase();

  if (/generate[-\s]?commit[-\s]?message|gitgeneratecommitmessage/.test(haystack)) {
    return 'commit message generation';
  }
  if (/commit/.test(haystack) && /dialog|modal|textarea|commit changes/.test(haystack)) {
    return 'commit dialog';
  }
  if (haystack.includes('foldertreeview')) return 'folder tree';
  if (haystack.includes('projecttreepanel')) return 'project tree';
  if (haystack.includes('promptinput')) return 'composer';
  if (haystack.includes('settings')) return 'settings';
  if (haystack.includes('browserpanel')) return 'browser panel';

  const componentPath = files.find((filePath) => filePath.includes('/components/'));
  if (componentPath) {
    return humanizeCommitTarget(basename(componentPath));
  }

  if (files.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath))) return 'docs';
  if (files.every((filePath) => /\.(test|spec)\.[jt]sx?$/i.test(filePath) || filePath.includes('__tests__'))) {
    return 'tests';
  }
  if (files.every((filePath) => /\.(css|scss|sass|less)$/i.test(filePath))) return 'styles';
  if (files.some((filePath) => filePath.startsWith('src/ui/'))) return 'UI';
  if (files.some((filePath) => filePath.startsWith('src/electron/'))) return 'electron';
  if (files.length === 1) return humanizeCommitTarget(basename(files[0]));

  return 'project files';
}

function inferCommitType(entries: Array<{ filePath: string; status: string }>, diffText: string): string {
  const files = entries.map((entry) => entry.filePath);
  const lowerDiff = diffText.toLowerCase();

  if (files.length > 0 && files.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath))) return 'docs';
  if (
    files.length > 0 &&
    files.every((filePath) => /\.(test|spec)\.[jt]sx?$/i.test(filePath) || filePath.includes('__tests__'))
  ) {
    return 'test';
  }
  if (files.length > 0 && files.every((filePath) => /\.(css|scss|sass|less)$/i.test(filePath))) return 'style';
  if (/generate[-\s]?commit[-\s]?message|gitgeneratecommitmessage/.test(`${files.join('\n')}\n${lowerDiff}`)) {
    return 'feat';
  }
  if (entries.some((entry) => entry.status === '?' || entry.status === 'A')) return 'feat';
  if (lowerDiff.includes('classname') && /text-\[|font-|px-|py-|rounded-|gap-/.test(diffText)) return 'style';
  if (/fix|bug|error|failed|failure|crash|overflow|covered|invalid|missing|permission/.test(lowerDiff)) return 'fix';
  if (files.some((filePath) => /(^|\/)(package-lock\.json|package\.json|tsconfig\.json|vite\.config\.ts)$/.test(filePath))) {
    return 'chore';
  }

  return 'chore';
}

function trimCommitSubject(subject: string): string {
  const clean = subject.replace(/[.!?。！？]+$/g, '').trim();
  if (clean.length <= 72) return clean;
  return clean.slice(0, 72).replace(/\s+\S*$/, '').replace(/[.!?。！？]+$/g, '').trim();
}

function generateCommitMessageFromGitChanges(
  entries: Array<{ filePath: string; status: string }>,
  diffText: string
): string {
  const files = entries.map((entry) => entry.filePath);
  const type = inferCommitType(entries, diffText);
  const target = inferCommitTarget(files, diffText);
  const verbByType: Record<string, string> = {
    feat: 'add',
    fix: 'fix',
    refactor: 'refactor',
    chore: 'update',
    style: 'adjust',
    docs: 'update',
    test: 'update',
  };
  const verb = verbByType[type] || 'update';

  return trimCommitSubject(`${type}: ${verb} ${target}`);
}

function parseGitHubRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const normalized = remoteUrl.trim();
  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

async function getGitOriginRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getGitUpstreamRef(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      {
        cwd,
        timeout: 5000,
      }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getGitAheadBehindCounts(
  cwd: string,
  upstreamRef: string | null
): Promise<{ aheadCount: number; behindCount: number }> {
  if (!upstreamRef) {
    return { aheadCount: 0, behindCount: 0 };
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`], {
      cwd,
      timeout: 5000,
    });
    const [aheadRaw, behindRaw] = stdout.trim().split('\t');
    return {
      aheadCount: Number(aheadRaw) || 0,
      behindCount: Number(behindRaw) || 0,
    };
  } catch {
    return { aheadCount: 0, behindCount: 0 };
  }
}

async function getGitDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], {
      cwd,
      timeout: 5000,
    });
    const fullRef = stdout.trim();
    const slashIndex = fullRef.indexOf('/');
    return slashIndex >= 0 ? fullRef.slice(slashIndex + 1) : fullRef || null;
  } catch {
    return null;
  }
}

async function getGitPullRequestInfo(input: {
  cwd: string;
  branch: string | null;
  originRepo: { owner: string; repo: string } | null;
}): Promise<{
  status: GitPullRequestLookupStatus;
  pr: { number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string } | null;
}> {
  if (!input.branch || !input.originRepo) {
    return { status: 'not_found', pr: null };
  }

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        '--head',
        input.branch,
        '--repo',
        `${input.originRepo.owner}/${input.originRepo.repo}`,
        '--json',
        'number,title,state,url',
      ],
      {
        cwd: input.cwd,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }
    );

    const parsed = JSON.parse(stdout) as {
      number?: number;
      title?: string;
      state?: string;
      url?: string;
    };

    if (
      typeof parsed.number === 'number' &&
      typeof parsed.title === 'string' &&
      typeof parsed.url === 'string' &&
      (parsed.state === 'OPEN' || parsed.state === 'CLOSED' || parsed.state === 'MERGED')
    ) {
      return {
        status: 'found',
        pr: {
          number: parsed.number,
          title: parsed.title,
          state:
            parsed.state === 'OPEN' ? 'open' : parsed.state === 'MERGED' ? 'merged' : 'closed',
          url: parsed.url,
        },
      };
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    if (/no pull requests? found/i.test(combined) || /could not resolve to a pullrequest/i.test(combined)) {
      return { status: 'not_found', pr: null };
    }
    return { status: 'unknown', pr: null };
  }

  return { status: 'unknown', pr: null };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

interface EditorCandidate {
  id: EnvironmentEditorId;
  label: string;
  appNames?: string[];
  commands?: string[];
}

const EDITOR_CANDIDATES: EditorCandidate[] = [
  { id: 'cursor', label: 'Cursor', appNames: ['Cursor'], commands: ['cursor'] },
  { id: 'vscode', label: 'VS Code', appNames: ['Visual Studio Code'], commands: ['code'] },
  { id: 'windsurf', label: 'Windsurf', appNames: ['Windsurf'], commands: ['windsurf'] },
  { id: 'zed', label: 'Zed', appNames: ['Zed'], commands: ['zed'] },
  { id: 'trae', label: 'Trae', appNames: ['Trae'], commands: ['trae'] },
  { id: 'intellij', label: 'IntelliJ IDEA', appNames: ['IntelliJ IDEA', 'IntelliJ IDEA CE'], commands: ['idea'] },
  { id: 'webstorm', label: 'WebStorm', appNames: ['WebStorm'], commands: ['webstorm'] },
  { id: 'sublime', label: 'Sublime Text', appNames: ['Sublime Text'], commands: ['subl'] },
  { id: 'xcode', label: 'Xcode', appNames: ['Xcode'], commands: ['xed'] },
  { id: 'terminal', label: 'Terminal', appNames: ['Terminal'] },
  { id: 'iterm', label: 'iTerm2', appNames: ['iTerm'] },
  { id: 'ghostty', label: 'Ghostty', appNames: ['Ghostty'] },
  { id: 'warp', label: 'Warp', appNames: ['Warp'] },
];

function getDarwinAppPath(appName: string): string | null {
  if (process.platform !== 'darwin') return null;
  const candidates = [
    `/Applications/${appName}.app`,
    join(homedir(), 'Applications', `${appName}.app`),
    // System apps (Terminal.app lives under /System/Applications/Utilities).
    `/System/Applications/${appName}.app`,
    `/System/Applications/Utilities/${appName}.app`,
  ];
  return candidates.find((appPath) => existsSync(appPath)) ?? null;
}

async function getNativeIconDataUrl(appPath: string | null): Promise<string | undefined> {
  if (!appPath || process.platform !== 'darwin') return undefined;

  let outputPath: string | null = null;
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist');
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plistPath], {
      timeout: 3000,
    });
    const iconFile = stdout.trim();
    if (!iconFile) return undefined;

    const iconFileName = iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`;
    const iconPath = join(appPath, 'Contents', 'Resources', iconFileName);
    if (!existsSync(iconPath)) return undefined;

    outputPath = join(tmpdir(), `aegis-app-icon-${uuidv4()}.png`);
    await execFileAsync('sips', ['-s', 'format', 'png', '-z', '128', '128', iconPath, '--out', outputPath], {
      timeout: 5000,
    });
    const png = await fsPromises.readFile(outputPath);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    if (outputPath) {
      void fsPromises.unlink(outputPath).catch(() => undefined);
    }
  }
}

async function getAvailableEditorCandidate(candidate: EditorCandidate): Promise<EnvironmentEditorLauncher | null> {
  const appPath = candidate.appNames?.map(getDarwinAppPath).find((path): path is string => Boolean(path));
  const appName = candidate.appNames?.find((name) => getDarwinAppPath(name));
  const commandChecks = await Promise.all((candidate.commands ?? []).map(async (command) => ({
    command,
    available: await commandExists(command),
  })));
  const command = commandChecks.find((check) => check.available)?.command;

  if (!appPath && !command) return null;

  return {
    id: candidate.id,
    label: candidate.label,
    available: true,
    appName,
    appPath,
    command,
    iconDataUrl: await getNativeIconDataUrl(appPath ?? null),
  };
}

async function getEnvironmentEditorLaunchers(): Promise<EnvironmentEditorLauncher[]> {
  const discoveredEditors = (await Promise.all(EDITOR_CANDIDATES.map(getAvailableEditorCandidate))).filter(
    (editor): editor is EnvironmentEditorLauncher => editor !== null,
  );

  const finderAppPath = process.platform === 'darwin' ? '/System/Library/CoreServices/Finder.app' : null;

  return [
    {
      id: 'finder',
      label: process.platform === 'darwin' ? 'Finder' : 'Files',
      available: true,
      appName: process.platform === 'darwin' ? 'Finder' : undefined,
      appPath: finderAppPath ?? undefined,
      iconDataUrl: await getNativeIconDataUrl(finderAppPath),
    },
    ...discoveredEditors,
  ];
}

async function openInEnvironmentEditor(input: OpenInEditorInput): Promise<{ ok: boolean; message?: string }> {
  const cwd = typeof input?.cwd === 'string' ? normalizeShellPath(input.cwd) : '';
  const editorId = input?.editorId;
  if (!cwd || !(await isReadableDirectory(cwd))) {
    return { ok: false, message: 'Workspace path is not readable.' };
  }

  try {
    if (editorId === 'finder') {
      shell.showItemInFolder(cwd);
      return { ok: true };
    }

    if (editorId === 'system') {
      const errMsg = await shell.openPath(cwd);
      return errMsg ? { ok: false, message: errMsg } : { ok: true };
    }

    const candidate = EDITOR_CANDIDATES.find((editor) => editor.id === editorId);
    if (!candidate) {
      return { ok: false, message: 'Unsupported editor.' };
    }

    const appName = candidate.appNames?.find((name) => getDarwinAppPath(name));
    if (appName) {
      await execFileAsync('open', ['-a', appName, cwd], { timeout: 10000 });
      return { ok: true };
    }

    const commandChecks = await Promise.all((candidate.commands ?? []).map(async (command) => ({
      command,
      available: await commandExists(command),
    })));
    const command = commandChecks.find((check) => check.available)?.command;
    if (command) {
      await execFileAsync(command, [cwd], { timeout: 10000 });
      return { ok: true };
    }

    return { ok: false, message: `${candidate.label} is not available.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function packSessionSummaryMaterials(
  materials: string[],
  maxChars = SESSION_SUMMARY_CHUNK_MAX_CHARS
): string[] {
  const packed: string[] = [];
  let current = '';

  const append = (value: string) => {
    const next = current ? `${current}\n\n${value}` : value;
    if (next.length > maxChars && current) {
      packed.push(current);
      current = value;
    } else {
      current = next;
    }
  };

  for (const material of materials) {
    const trimmed = material.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      append(trimmed);
      continue;
    }
    for (let offset = 0; offset < trimmed.length; offset += maxChars) {
      append(trimmed.slice(offset, offset + maxChars));
    }
  }

  if (current) packed.push(current);
  return packed;
}

async function runSessionSummaryOneShot(
  session: SessionRow,
  prompt: string
): Promise<{ text: string; model: string | null }> {
  const cwd = session.worktree_path || session.cwd || session.project_cwd || process.cwd();
  const model = session.model || undefined;

  if (session.provider === 'claude') {
    const result = await runClaudeOneShot({
      prompt,
      cwd,
      model,
      compatibleProviderId: session.compatible_provider_id || undefined,
      betas: parseStoredBetas(session.betas),
      claudeReasoningEffort: 'low',
    });
    return { text: result.text, model: result.model || model || 'claude' };
  }

  if (session.provider === 'codex') {
    const result = await runCodexOneShot({
      prompt,
      cwd,
      model,
      codexExecutionMode: 'plan',
      codexPermissionMode: 'defaultPermissions',
      codexReasoningEffort: 'low',
      codexFastMode: false,
    });
    return { text: result.text, model: result.model || model || 'codex' };
  }

  if (session.provider === 'opencode') {
    const result = await runOpenCodeOneShot({
      prompt,
      cwd,
      model,
      opencodePermissionMode: session.opencode_permission_mode || undefined,
    });
    return { text: result.text, model: result.model || model || 'opencode' };
  }

  ensureProviderService();
  const result = await getProviderService().runOneShot({
    provider: session.provider,
    threadId: `environment-summary-${session.id}-${uuidv4()}`,
    cwd,
    prompt,
    model,
  });
  return { text: result.text, model: result.model || model || session.provider };
}

async function condenseSessionSummaryMaterial(
  session: SessionRow,
  entries: SessionSummaryEntry[]
): Promise<string> {
  let materials = chunkSessionSummaryEntries(entries);
  if (materials.length <= 1) return materials[0] || '';

  for (let round = 0; round < 5 && materials.length > 1; round += 1) {
    const notes: string[] = [];
    for (let index = 0; index < materials.length; index += 1) {
      const result = await runSessionSummaryOneShot(
        session,
        buildSessionSummaryChunkPrompt({
          sessionTitle: session.title,
          transcriptChunk: materials[index],
          part: index + 1,
          totalParts: materials.length,
        })
      );
      const note = extractSummaryContent(result.text);
      if (!note) {
        throw new Error('The summary model returned empty notes for part of the session.');
      }
      notes.push(note);
    }
    materials = packSessionSummaryMaterials(notes);
  }

  if (materials.length !== 1) {
    throw new Error('The session is too large to condense into a safe summary request.');
  }
  return materials[0];
}

async function generateSessionWideSummary(params: {
  session: SessionRow;
  entries: SessionSummaryEntry[];
  previousSummary?: string | null;
  incremental?: boolean;
}): Promise<{ summary: string; model: string | null }> {
  const sourceText = await condenseSessionSummaryMaterial(params.session, params.entries);
  const result = await runSessionSummaryOneShot(
    params.session,
    buildSessionSummaryPrompt({
      sessionTitle: params.session.title,
      sourceText,
      previousSummary: params.previousSummary,
      incremental: params.incremental,
    })
  );
  const summary = extractSummaryContent(result.text);
  if (!summary) {
    throw new Error('The summary model returned an empty session summary.');
  }
  return { summary, model: result.model };
}

const sessionSummaryRefreshes = new Map<string, Promise<SessionEnvironmentRecap>>();

async function refreshSessionEnvironmentSummary(
  session: SessionRow
): Promise<SessionEnvironmentRecap> {
  const history = sessions.getSessionHistory(session.id);
  const entries = collectSessionSummaryEntries(history);
  if (entries.length === 0) {
    throw new Error('This session does not have enough conversation to summarize yet.');
  }

  const previousState = sessions.getSessionEnvironmentRecapGenerationState(session.id);
  const previousMetadata = parseSessionSummarySourceIds(previousState?.sourceIds);
  if (
    previousState &&
    previousState.model !== 'local' &&
    isSessionSummaryCurrent(entries, previousMetadata)
  ) {
    return sessions.getSessionEnvironmentRecap(session.id);
  }

  const canIncrement = Boolean(
    previousState?.summary &&
      previousState.model !== 'local' &&
      previousMetadata &&
      previousMetadata.incrementalUpdates < SESSION_SUMMARY_MAX_INCREMENTAL_UPDATES &&
      isAppendOnlySessionSummaryUpdate(entries, previousMetadata)
  );
  const entriesToSummarize = canIncrement
    ? entries.slice(previousMetadata!.entryCount)
    : entries;
  const generated = await generateSessionWideSummary({
    session,
    entries: entriesToSummarize,
    previousSummary: canIncrement ? previousState!.summary : null,
    incremental: canIncrement,
  });
  const incrementalUpdates = canIncrement
    ? previousMetadata!.incrementalUpdates + 1
    : 0;

  return sessions.saveSessionEnvironmentRecap({
    sessionId: session.id,
    summary: generated.summary,
    sourceIds: buildSessionSummarySourceIds(entries, incrementalUpdates),
    model: generated.model || session.model || session.provider,
  });
}

async function refreshSessionEnvironmentRecapDeduped(
  session: SessionRow,
  mainWindow: BrowserWindow | null
): Promise<SessionEnvironmentRecap> {
  const existing = sessionSummaryRefreshes.get(session.id);
  if (existing) return existing;

  const promise = refreshSessionEnvironmentSummary(session)
    .then((recap) => {
      if (mainWindow) {
        broadcast(mainWindow, {
          type: 'session.environmentRecap',
          payload: { sessionId: session.id, recap },
        });
      }
      return recap;
    })
    .catch((error) => {
      console.error('[session-recap]', session.id, error);
      throw error;
    })
    .finally(() => {
      sessionSummaryRefreshes.delete(session.id);
    });

  sessionSummaryRefreshes.set(session.id, promise);
  return promise;
}

function scheduleSessionEnvironmentRecapRefresh(
  session: SessionRow,
  mainWindow: BrowserWindow
): void {
  void refreshSessionEnvironmentRecapDeduped(session, mainWindow).catch(() => {});
}

// 初始化 IPC 处理器
export function setupIPCHandlers(mainWindow: BrowserWindow): void {
  // 初始化数据库
  sessions.initialize();

  // 加载 Claude 配置
  loadClaudeSettings();

  feishuBridge.setHandlers({
    startSession: async ({ title, prompt, cwd, provider, model }) => {
      return handleSessionStart(mainWindow, { title, prompt, cwd, provider, model });
    },
    continueSession: async ({ sessionId, prompt, provider, model }) => {
      return handleSessionContinue(mainWindow, { sessionId, prompt, provider, model });
    },
    resolvePermission: ({ sessionId, toolUseId, result }) => {
      return handlePermissionResponse({ sessionId, toolUseId, result });
    },
  });
  void feishuBridge.maybeAutoStart();

  // 启动期清算必须先于任何 runner/scheduler 启动：app 崩溃/强退后残留的
  // running session 没有任何 runner 句柄，不清算会永远卡在 running。
  const sweptSessions = sessions.sweepOrphanRunningSessions();
  if (sweptSessions > 0) {
    console.log(`[Sessions] swept ${sweptSessions} orphan running session(s) on boot`);
  }

  // Process-scoped provider events have no per-runner owner, so they ride a
  // DIRECT service.events subscription (the per-runner forwarder filters by
  // threadId and dies with abort). Currently: the codex model catalog push —
  // it feeds fast-mode eligibility enrichment (P0-3).
  ensureProviderService();
  getProviderService().events.on('event', (event) => {
    if (event.type === 'model_catalog_updated') {
      setCodexRuntimeModelCatalog(event.models);
      if (!mainWindow.isDestroyed()) {
        broadcast(mainWindow, { type: 'codex.modelCatalogUpdated', payload: {} });
      }
    }
  });

  configureNotifications({
    isWindowFocused: () =>
      !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused(),
    onActivate: (target) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        broadcast(mainWindow, {
          type: 'app.focusSession',
          payload: { sessionId: target.sessionId },
        });
      }
    },
  });

  // 全局 session 状态监听：session 完成/失败时发系统通知
  sessions.setSessionStatusListener((row, previousStatus) => {
    if (
      previousStatus === 'running' &&
      row.status !== 'running' &&
      row.hidden_from_threads !== 1
    ) {
      notifySessionDone(row);
    }
  });

  automationScheduler?.stop();
  automationScheduler = new AutomationScheduler(
    (payload) => handleSessionStart(mainWindow, payload),
    () => broadcastAutomationChanged(mainWindow)
  );
  automationScheduler.start();

  ipcMainHandle('get-notification-settings', async () => getNotificationSettings());

  ipcMainHandle(
    'set-notification-settings',
    async (_event, next: Partial<import('./libs/notifications').NotificationSettings>) =>
      setNotificationSettings(next)
  );

  // 处理客户端事件
  ipcMain.removeAllListeners('client-event');
  ipcMain.on('client-event', async (_, eventJson: string) => {
    try {
      const event: ClientEvent = JSON.parse(eventJson);
      await handleClientEvent(mainWindow, event);
    } catch (error) {
      console.error('Error handling client event:', error);
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message: String(error) },
      });
    }
  });

  // RPC: 生成会话标题
  ipcMainHandle('generate-session-title', async (_, prompt: string) => {
    return generateSessionTitle(prompt);
  });

  // Fork a codex/opencode conversation: fork the provider-side thread through
  // the adapter (codex `thread/fork`, opencode `session.fork`), then mirror the
  // Aegis session row and transcript so both branches continue independently.
  async function forkProviderThreadSession(
    source: import('./types').SessionRow,
    provider: 'codex' | 'opencode'
  ): Promise<{ ok: true; session: SessionInfo } | { ok: false; message: string }> {
    const providerThreadId =
      provider === 'codex' ? source.codex_session_id : source.opencode_session_id;
    if (!providerThreadId) {
      return {
        ok: false as const,
        message: 'Send a message first — there is no conversation to fork yet.',
      };
    }

    // Adapters register lazily on the first agent run; make sure they exist
    // even when forking is the first provider interaction after launch.
    ensureProviderService();
    const adapter = getProviderService().getAdapter(provider);
    if (!adapter?.forkThread) {
      return { ok: false as const, message: `Forking is not available for ${provider}.` };
    }

    const forkedThreadId = await adapter.forkThread({
      cwd: source.cwd || process.cwd(),
      providerThreadId,
    });

    const fork = sessions.createSession({
      title: `${source.title} (fork)`,
      cwd: source.cwd || undefined,
      projectCwd: source.project_cwd ?? source.cwd ?? null,
      envMode: source.env_mode === 'worktree' ? 'worktree' : 'local',
      worktreePath: source.worktree_path ?? null,
      associatedWorktreePath: source.associated_worktree_path ?? null,
      associatedWorktreeBranch: source.associated_worktree_branch ?? null,
      associatedWorktreeRef: source.associated_worktree_ref ?? null,
      provider,
      model: source.model || undefined,
      scope: normalizeSessionScope(source.conversation_scope),
      agentId: source.agent_id || null,
      codexExecutionMode: normalizeCodexExecutionMode(source.codex_execution_mode),
      codexPermissionMode: normalizeCodexPermissionMode(source.codex_permission_mode),
      codexReasoningEffort: normalizeCodexReasoningEffort(source.codex_reasoning_effort),
      codexFastMode: normalizeCodexFastMode(source.codex_fast_mode),
      opencodePermissionMode: normalizeOpenCodePermissionMode(source.opencode_permission_mode),
      channelId: normalizeWorkspaceChannelId(source.workspace_channel_id),
      teamMode: normalizeSessionTeamMode(source.team_mode),
      teamId: source.team_id || null,
    });

    if (provider === 'codex') {
      sessions.updateCodexSessionId(fork.id, forkedThreadId);
    } else {
      sessions.updateOpencodeSessionId(fork.id, forkedThreadId);
    }

    // Copy the transcript (re-keyed) so the forked pane shows the conversation.
    sessions.copySessionHistory(source.id, fork.id);

    const row = sessions.getSession(fork.id);
    if (!row) {
      return { ok: false as const, message: 'Failed to read the forked session.' };
    }
    return { ok: true as const, session: buildSessionInfoFromRow(row) };
  }

  // Fork a Claude conversation into a new session (branch the transcript).
  async function forkSessionInternal(
    sourceSessionId: string
  ): Promise<{ ok: true; session: SessionInfo } | { ok: false; message: string }> {
    try {
      const source = sessions.getSession(sourceSessionId);
      if (!source) {
        return { ok: false as const, message: 'Session not found.' };
      }
      const sourceProvider = (source.provider || 'claude') as AgentProvider;
      if (sourceProvider === 'codex' || sourceProvider === 'opencode') {
        return forkProviderThreadSession(source, sourceProvider);
      }
      if (sourceProvider !== 'claude') {
        return {
          ok: false as const,
          message: 'Forking is only supported for Claude, Codex, and OpenCode sessions.',
        };
      }
      // The app doesn't always persist claude_session_id (it can resume by
      // rebuilding from history). If it's missing, bootstrap a resumable
      // session from the transcript first, then fork that.
      let sourceClaudeId = source.claude_session_id || undefined;
      if (!sourceClaudeId) {
        const sourceHistory = sessions.getSessionHistory(sourceSessionId);
        if (sourceHistory.length === 0) {
          return {
            ok: false as const,
            message: 'Send a message first — there is no conversation to fork yet.',
          };
        }
        const bootstrap = await bootstrapClaudeSessionFromHistory({
          history: sourceHistory,
          cwd: source.cwd,
          model: source.model,
          compatibleProviderId: source.compatible_provider_id || undefined,
          betas: parseStoredBetas(source.betas),
          claudeReasoningEffort: normalizeClaudeReasoningEffort(source.claude_reasoning_effort),
        });
        sourceClaudeId = bootstrap.sessionId;
        // Persist so future forks/resumes of the source are instant.
        sessions.setClaudeSessionId(sourceSessionId, sourceClaudeId);
      }

      const forkedClaudeId = await forkClaudeAgentSession(sourceClaudeId, source.cwd || undefined);

      const fork = sessions.createSession({
        title: `${source.title} (fork)`,
        cwd: source.cwd || undefined,
        projectCwd: source.project_cwd ?? source.cwd ?? null,
        envMode: source.env_mode === 'worktree' ? 'worktree' : 'local',
        worktreePath: source.worktree_path ?? null,
        associatedWorktreePath: source.associated_worktree_path ?? null,
        associatedWorktreeBranch: source.associated_worktree_branch ?? null,
        associatedWorktreeRef: source.associated_worktree_ref ?? null,
        provider: 'claude',
        model: source.model || undefined,
        scope: normalizeSessionScope(source.conversation_scope),
        agentId: source.agent_id || null,
        compatibleProviderId: source.compatible_provider_id || undefined,
        betas: parseStoredBetas(source.betas),
        claudeAccessMode: normalizeClaudeAccessMode(source.claude_access_mode),
        claudeExecutionMode: normalizeClaudeExecutionMode(
          source.claude_execution_mode,
          source.claude_access_mode
        ),
        claudeReasoningEffort: normalizeClaudeReasoningEffort(source.claude_reasoning_effort),
        channelId: normalizeWorkspaceChannelId(source.workspace_channel_id),
        teamMode: normalizeSessionTeamMode(source.team_mode),
        teamId: source.team_id || null,
      });

      sessions.setClaudeSessionId(fork.id, forkedClaudeId);

      // Copy the transcript (re-keyed) so the forked pane shows the conversation.
      sessions.copySessionHistory(sourceSessionId, fork.id);

      const row = sessions.getSession(fork.id);
      if (!row) {
        return { ok: false as const, message: 'Failed to read the forked session.' };
      }
      return { ok: true as const, session: buildSessionInfoFromRow(row) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, message };
    }
  }

  ipcMainHandle('fork-session', async (_event, sourceSessionId: string) => {
    return forkSessionInternal(sourceSessionId);
  });

  // Provider handoff: sessions are locked to one agent; switching creates a
  // new session for the target provider that imports the transcript and
  // injects it as context on the first prompt (synara-style thread handoff).
  ipcMainHandle(
    'session-handoff',
    async (
      _event,
      payload: { sessionId: string; targetProvider: AgentProvider }
    ): Promise<{ ok: true; session: SessionInfo } | { ok: false; message: string }> => {
      try {
        const source = sessions.getSession(payload?.sessionId || '');
        if (!source) {
          return { ok: false as const, message: 'Session not found.' };
        }
        const sourceProvider = (source.provider || 'claude') as AgentProvider;
        const targetProvider = payload?.targetProvider;
        if (!targetProvider || targetProvider === sourceProvider) {
          return { ok: false as const, message: 'Pick a different agent to hand off to.' };
        }
        const history = sessions.getSessionHistory(source.id);
        if (collectHandoffTranscriptEntries(history).length === 0) {
          return {
            ok: false as const,
            message: 'Send a message first — there is no conversation to hand off yet.',
          };
        }

        const handoff = sessions.createSession({
          title: source.title,
          cwd: source.cwd || undefined,
          projectCwd: source.project_cwd ?? source.cwd ?? null,
          envMode: source.env_mode === 'worktree' ? 'worktree' : 'local',
          worktreePath: source.worktree_path ?? null,
          associatedWorktreePath: source.associated_worktree_path ?? null,
          associatedWorktreeBranch: source.associated_worktree_branch ?? null,
          associatedWorktreeRef: source.associated_worktree_ref ?? null,
          provider: targetProvider,
          scope: normalizeSessionScope(source.conversation_scope),
          agentId: source.agent_id || null,
          channelId: normalizeWorkspaceChannelId(source.workspace_channel_id),
          teamMode: normalizeSessionTeamMode(source.team_mode),
          teamId: source.team_id || null,
        });

        // Copy the transcript so the handoff pane shows the conversation; the
        // pending flag makes the first prompt carry it as <handoff_context>.
        sessions.copySessionHistory(source.id, handoff.id);
        sessions.setSessionHandoff(handoff.id, sourceProvider);

        const row = sessions.getSession(handoff.id);
        if (!row) {
          return { ok: false as const, message: 'Failed to read the handoff session.' };
        }
        return { ok: true as const, session: buildSessionInfoFromRow(row) };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : 'Failed to create the handoff session.',
        };
      }
    }
  );

  // Claude rewind: restore files (SDK checkpoint) and/or truncate the
  // conversation back to the state before a given user message ran.
  ipcMainHandle('claude-rewind', async (_event, input: ClaudeRewindInput): Promise<ClaudeRewindResult> => {
    const { sessionId, anchorMessageId, scope, dryRun } = input || ({} as ClaudeRewindInput);
    const session = sessions.getSession(sessionId);
    if (!session) {
      return { ok: false, message: 'Session not found.', filesAvailable: false };
    }
    if (session.provider !== 'claude') {
      return { ok: false, message: 'Rewind is only available for Claude sessions.', filesAvailable: false };
    }
    if (!anchorMessageId) {
      return { ok: false, message: 'Missing rewind anchor.', filesAvailable: false };
    }

    const entry = runnerHandles.get(sessionId);
    const rewindFilesFn = entry?.provider === 'claude' ? entry.handle.rewindFiles : undefined;
    const filesAvailable = typeof rewindFilesFn === 'function';

    const runFilesRewind = async (isDryRun: boolean): Promise<ClaudeRewindFilesOutcome> => {
      try {
        return await rewindFilesFn!(anchorMessageId, { dryRun: isDryRun });
      } catch (error) {
        return { canRewind: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    if (dryRun) {
      return {
        ok: true,
        filesAvailable,
        files: filesAvailable ? await runFilesRewind(true) : null,
      };
    }

    let filesOutcome: ClaudeRewindFilesOutcome | null = null;
    if (scope === 'files' || scope === 'both') {
      if (!filesAvailable) {
        if (scope === 'files') {
          return {
            ok: false,
            message: 'File rewind needs a live Claude runtime. Send any message in this session first, then retry.',
            filesAvailable,
          };
        }
      } else {
        filesOutcome = await runFilesRewind(false);
        if (!filesOutcome.canRewind && scope === 'files') {
          return {
            ok: false,
            message: filesOutcome.error || 'Files could not be rewound to this checkpoint.',
            filesAvailable,
            files: filesOutcome,
          };
        }
      }
    }

    let removedPrompt: string | null = null;
    if (scope === 'conversation' || scope === 'both') {
      const history = sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId)).messages;
      const anchorIndex = history.findIndex(
        (message) => (message as { uuid?: string }).uuid === anchorMessageId
      );
      if (anchorIndex === -1) {
        return {
          ok: false,
          message: 'The rewind anchor was not found in this session history.',
          filesAvailable,
          files: filesOutcome,
        };
      }

      // The checkpoint semantics are "before this user message ran": drop the
      // SDK user message, everything after it, and the synthesized user_prompt
      // that immediately precedes it (so its text can go back to the composer).
      let cutIndex = anchorIndex;
      for (let index = anchorIndex - 1; index >= 0; index -= 1) {
        const type = history[index]?.type;
        if (type === 'user_prompt') {
          cutIndex = index;
          break;
        }
        if (type === 'assistant' || type === 'result' || type === 'user') {
          break;
        }
      }
      const cutMessage = history[cutIndex];
      if (cutMessage?.type === 'user_prompt') {
        removedPrompt = cutMessage.prompt;
      }
      const preservedHistory = history.slice(0, cutIndex);

      if (entry) {
        entry.handle.abort();
        runnerHandles.delete(sessionId);
      }

      let lastPrompt = '';
      for (let index = preservedHistory.length - 1; index >= 0; index -= 1) {
        const message = preservedHistory[index];
        if (message?.type === 'user_prompt') {
          lastPrompt = message.prompt;
          break;
        }
      }

      sessions.replaceSessionHistory(sessionId, preservedHistory);
      sessions.updateSessionStatus(sessionId, 'completed');
      sessions.updateLastPrompt(sessionId, lastPrompt);
      sessions.setClaudeSessionId(sessionId, null);

      broadcast(mainWindow, {
        type: 'session.history',
        payload: { sessionId, status: 'completed', messages: preservedHistory },
      });
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId,
          status: 'completed',
          provider: 'claude',
          hiddenFromThreads: session.hidden_from_threads === 1,
        },
      });

      if (preservedHistory.length > 0) {
        try {
          const bootstrap = await bootstrapClaudeSessionFromHistory({
            history: preservedHistory,
            cwd: session.cwd,
            model: normalizeModel(session.model ?? undefined),
            compatibleProviderId: session.compatible_provider_id ?? undefined,
            betas: parseStoredBetas(session.betas),
            claudeReasoningEffort: normalizeClaudeReasoningEffort(session.claude_reasoning_effort),
          });
          sessions.setClaudeSessionId(sessionId, bootstrap.sessionId || null);
        } catch (error) {
          // History is already truncated; without a bootstrap the next prompt
          // simply starts a fresh CLI session over the truncated visible
          // history instead of resuming, so this is safe to only log.
          console.warn('[claude-rewind] context rebuild failed:', error);
        }
      }
    }

    return { ok: true, filesAvailable, files: filesOutcome, removedPrompt };
  });

  // 把现有 thread 本身挪进新 worktree（不 fork 对话，provider 无关）：
  // 同一个会话继续聊，只是 cwd 换成隔离检出。
  const movesInFlight = new Set<string>();
  ipcMainHandle('move-session-to-worktree', async (_event, sessionId: string) => {
    const row = sessions.getSession(sessionId);
    if (!row) return { ok: false, message: 'Session not found.' };
    // 只信 DB status：非 Claude 的 runner 句柄在 turn 结束后仍驻留（连接复用），
    // runnerHandles.has() 不代表正在跑
    if (row.status === 'running') {
      return { ok: false, message: 'Wait for the agent to finish before moving the thread.' };
    }
    if (row.env_mode === 'worktree' && row.worktree_path) {
      return { ok: false, message: 'This thread is already in a worktree.' };
    }
    // 起名期间重复触发会各建一个 worktree，后写的赢、先建的成孤儿——在源头拒绝
    if (movesInFlight.has(sessionId)) {
      return { ok: false, message: 'This thread is already being moved.' };
    }
    movesInFlight.add(sessionId);
    try {
      // Moving the thread changes its cwd; retire any kept-alive runner (any
      // provider) that captured the old directory at spawn.
      retireSessionRunner(sessionId);
      // 标题能产出合法分支名就直接用（标题通常已是 LLM 起的），move 保持秒级；
      // slug 化失败（如中文标题）才请该 thread 的 provider 起英文名，失败退回本地命名
      const labelHint = row.title || row.last_prompt || 'worktree';
      const nameHint = branchSlugFromHint(labelHint)
        ? labelHint
        : await generateWorktreeBranchSlug({
            prompt: labelHint,
            cwd: row.project_cwd || row.cwd || undefined,
            provider: (row.provider || 'claude') as AgentProvider,
            model: row.model || undefined,
            compatibleProviderId: row.compatible_provider_id || undefined,
          });
      const result = await assignIsolatedWorkspace(sessionId, nameHint);
      if (result.ok) broadcastSessionWorkspace(mainWindow, sessionId);
      return result;
    } finally {
      movesInFlight.delete(sessionId);
    }
  });

  ipcMainHandle('apply-worktree-changes', async (_event, sessionId: string) => {
    // Capture before the apply: on success the row's worktree fields are
    // cleared and the directory is force-removed.
    const row = sessions.getSession(sessionId);
    const worktreePath = row?.worktree_path || null;
    const projectCwd = row?.project_cwd || null;
    // The worktree is force-removed without a reference check — a sibling
    // session running inside it would lose its checkout mid-turn.
    const runningSibling = worktreePath ? findRunningSessionUnderPath(worktreePath, sessionId) : null;
    if (runningSibling) {
      return {
        ok: false,
        message: `Another running session is using this worktree: ${runningSibling.title || runningSibling.id}. Wait for it to finish first.`,
      };
    }
    const result = await applyIsolatedWorkspace(sessionId);
    if (result.ok) {
      // The worktree directory is gone and the session moved back to the
      // project folder — retire its kept-alive runner plus any other runner
      // anchored inside the removed checkout.
      retireSessionRunner(sessionId);
      if (worktreePath) retireRunnersUnderPath(worktreePath);
      // The squash-merge also rewrote files in the project checkout; idle
      // runners anchored there hold stale context, same as a branch switch.
      if (projectCwd) await flushRunnersSharingGitRoot(projectCwd);
      broadcastSessionWorkspace(mainWindow, sessionId);
    }
    return result;
  });

  ipcMainHandle('discard-worktree-changes', async (_event, sessionId: string) => {
    const worktreePath = sessions.getSession(sessionId)?.worktree_path || null;
    const runningSibling = worktreePath ? findRunningSessionUnderPath(worktreePath, sessionId) : null;
    if (runningSibling) {
      return {
        ok: false,
        message: `Another running session is using this worktree: ${runningSibling.title || runningSibling.id}. Wait for it to finish first.`,
      };
    }
    const result = await discardIsolatedWorkspace(sessionId);
    if (result.ok) {
      // Same as apply: the checkout was force-removed; no live runner may
      // keep the dead cwd. (No project-root flush here — discard does not
      // touch the project checkout's contents.)
      retireSessionRunner(sessionId);
      if (worktreePath) retireRunnersUnderPath(worktreePath);
      broadcastSessionWorkspace(mainWindow, sessionId);
    }
    return result;
  });

  // RPC: 获取最近工作目录
  ipcMainHandle('get-recent-cwds', async (_, limit?: number) => {
    return sessions.listRecentCwds(limit);
  });

  ipcMainHandle('get-automations', async () => {
    return getAutomationSnapshot();
  });

  ipcMainHandle('save-automation', async (_event, input: UpsertAutomationInput) => {
    const automation = sessions.saveAutomation(input);
    broadcastAutomationChanged(mainWindow);
    return automation;
  });

  ipcMainHandle('delete-automation', async (_event, automationId: string) => {
    const ok = sessions.deleteAutomation(automationId);
    broadcastAutomationChanged(mainWindow);
    return { ok };
  });

  ipcMainHandle('set-automation-enabled', async (_event, automationId: string, enabled: boolean) => {
    const automation = sessions.setAutomationEnabled(automationId, enabled);
    broadcastAutomationChanged(mainWindow);
    return automation;
  });

  ipcMainHandle('run-automation-now', async (_event, automationId: string) => {
    if (!automationScheduler) {
      return { ok: false, message: 'Automation scheduler is not running.' };
    }
    const result = await automationScheduler.runNow(automationId);
    broadcastAutomationChanged(mainWindow);
    return result;
  });

  ipcMainHandle('set-window-min-size', async (_event, width: number, height: number) => {
    const safeWidth = Number.isFinite(width) ? Math.max(400, Math.round(width)) : 800;
    const safeHeight = Number.isFinite(height) ? Math.max(400, Math.round(height)) : 600;

    mainWindow.setMinimumSize(safeWidth, safeHeight);

    const [currentWidth, currentHeight] = mainWindow.getSize();
    const nextWidth = Math.max(currentWidth, safeWidth);
    const nextHeight = Math.max(currentHeight, safeHeight);
    if (nextWidth !== currentWidth || nextHeight !== currentHeight) {
      mainWindow.setSize(nextWidth, nextHeight);
    }

    return { ok: true };
  });

  ipcMainHandle('search-chat-messages', async (_event, query: string, limit?: number) => {
    return sessions.searchChatMessages(query, limit);
  });

  ipcMainHandle('load-older-session-history', async (_event, sessionId: string, cursor: string, limit?: number) => {
    const session = sessions.getSession(sessionId);
    if (!session) {
      throw new Error('Unknown session');
    }

    const unifiedSession = toUnifiedSessionRecord(session);
    const source = getHistorySourceForSession(unifiedSession);
    const page = await source.loadBefore(unifiedSession, cursor, Math.max(1, Math.min(200, Math.trunc(limit || 100))));
    const finalMessages =
      session.provider === 'claude' && session.session_origin === 'aegis'
        ? sanitizeStoredClaudeHistory(sessionId, page.messages).messages
        : page.messages;

    return {
      sessionId,
      status: session.status as SessionInfo['status'],
      messages: finalMessages,
      cursor: page.cursor,
      hasMore: page.hasMore,
    };
  });

  // Full-history index of user prompts for the chat outline rail. Kept
  // lightweight (truncated texts + file/attachment names) so long sessions do
  // not ship their entire transcripts to the renderer twice.
  ipcMainHandle('get-session-user-prompts', async (_event, sessionId: string) => {
    const session = sessions.getSession(sessionId);
    if (!session) {
      throw new Error('Unknown session');
    }

    const unifiedSession = toUnifiedSessionRecord(session);
    const source = getHistorySourceForSession(unifiedSession);
    const messages = await source.loadAll(unifiedSession);
    return buildSessionUserPromptSummaries(messages);
  });

  ipcMainHandle(
    'load-session-history-around',
    async (_event, sessionId: string, messageCreatedAt: number, before?: number, after?: number) => {
      const session = sessions.getSession(sessionId);
      if (!session) {
        throw new Error('Unknown session');
      }

      const unifiedSession = toUnifiedSessionRecord(session);
      const source = getHistorySourceForSession(unifiedSession);
      const page = await source.loadAround(
        unifiedSession,
        messageCreatedAt,
        Math.max(0, Math.min(200, Math.trunc(before ?? 30))),
        Math.max(0, Math.min(200, Math.trunc(after ?? 30)))
      );
      const finalMessages =
        session.provider === 'claude' && session.session_origin === 'aegis'
          ? sanitizeStoredClaudeHistory(sessionId, page.messages).messages
          : page.messages;

      return {
        sessionId,
        status: session.status as SessionInfo['status'],
        messages: finalMessages,
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
    }
  );

  // RPC: 获取 Claude 模型配置(官方目录优先,本地记录兜底)
  ipcMainHandle('get-claude-model-config', async () => {
    return getClaudeModelConfigWithCatalog();
  });

  // RPC: 获取 Claude-compatible provider 配置
  ipcMainHandle('get-claude-compatible-provider-config', async () => {
    return loadCompatibleProviderConfig();
  });

  // RPC: 保存 Claude-compatible provider 配置
  ipcMainHandle('save-claude-compatible-provider-config', async (_, config: ClaudeCompatibleProvidersConfig) => {
    saveCompatibleProviderConfig(config);
    invalidateClaudeRuntimeCache(); // 配置变更后清除缓存，下次发消息时重新检查
    // Live runners captured the previous provider env (keys, base URLs) at
    // spawn — retire them so the next turn picks up the new config.
    flushClaudeRunners();
    return loadCompatibleProviderConfig();
  });

  ipcMainHandle('get-wechat-html-generator-config', async () => {
    return loadWechatHtmlGeneratorConfig();
  });

  ipcMainHandle('save-wechat-html-generator-config', async (_, config: WechatMarkdownHtmlGeneratorConfig) => {
    return saveWechatHtmlGeneratorConfig(config);
  });

  ipcMainHandle('generate-wechat-markdown-html', async (_, input: WechatMarkdownHtmlGenerationInput) => {
    return generateWechatMarkdownHtml(input);
  });

  ipcMainHandle('write-wechat-clipboard-html', async (_, input: WechatClipboardHtmlWriteInput) => {
    try {
      const html = typeof input?.html === 'string' ? input.html : '';
      if (!html.trim()) {
        return { ok: false, error: 'HTML 内容为空' };
      }
      clipboard.writeHTML(html);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // RPC: 获取 Claude usage 报表
  ipcMainHandle('get-claude-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getClaudeUsageReport(days);
  });

  ipcMainHandle('get-codex-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getCodexUsageReport(days);
  });

  ipcMainHandle('get-opencode-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getOpencodeUsageReport(days);
  });

  // RPC: 任意 provider 的 usage 报表(kimi/grok/pi 走 Claude 协议报表)
  ipcMainHandle('get-agent-usage-report', async (_, provider: AgentProvider, days?: ClaudeUsageRangeDays) => {
    return sessions.getAgentUsageReport(provider, days);
  });

  ipcMainHandle('get-prompt-library', async () => {
    return listPromptLibraryItems();
  });

  ipcMainHandle('save-prompt-library-item', async (_event, input: UpsertPromptLibraryItemInput) => {
    return savePromptLibraryItem(input);
  });

  ipcMainHandle('delete-prompt-library-item', async (_event, id: string) => {
    return deletePromptLibraryItem(id);
  });

  ipcMainHandle('import-prompt-library', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        items: listPromptLibraryItems(),
        importedCount: 0,
        skippedCount: 0,
        filePath: null,
      };
    }

    return importPromptLibraryFile(result.filePaths[0]);
  });

  ipcMainHandle('export-prompt-library', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'prompt-library.json',
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return {
        canceled: true,
        filePath: null,
        count: listPromptLibraryItems().length,
      };
    }

    return exportPromptLibraryFile(result.filePath);
  });

  // RPC: 获取 Codex 模型配置
  ipcMainHandle('get-codex-model-config', async () => {
    return getCodexModelConfig();
  });

  ipcMainHandle('save-codex-model-visibility', async (_event, enabledModels: string[]) => {
    return saveCodexModelVisibility(enabledModels);
  });

  ipcMainHandle('get-codex-runtime-status', async () => {
    return getCodexRuntimeStatus();
  });

  ipcMainHandle('get-codex-rate-limits', async () => {
    ensureProviderService();
    const rateLimits = await getProviderService().getRateLimits('codex');
    if (!rateLimits) {
      throw new Error('Codex rate limits are not available from this runtime.');
    }
    return rateLimits;
  });

  ipcMainHandle('get-claude-plan-usage', async () => {
    return getClaudePlanUsage();
  });

  ipcMainHandle('get-grok-plan-usage', async () => {
    return getGrokPlanUsage();
  });

  ipcMainHandle('codex-get-composer-capabilities', async () => {
    ensureProviderService();
    return getProviderService().getComposerCapabilities('codex');
  });

  ipcMainHandle('codex-list-skills', async (_event, input?: Omit<ProviderListSkillsInput, 'provider'>) => {
    ensureProviderService();
    return getProviderService().listSkills({
      provider: 'codex',
      cwd: input?.cwd,
      threadId: input?.threadId,
      forceReload: input?.forceReload,
    });
  });

  ipcMainHandle('codex-list-plugins', async (_event, input?: Omit<ProviderListPluginsInput, 'provider'>) => {
    ensureProviderService();
    return getProviderService().listPlugins({
      provider: 'codex',
      cwd: input?.cwd,
      threadId: input?.threadId,
      forceReload: input?.forceReload,
      forceRemoteSync: input?.forceRemoteSync,
    });
  });

  ipcMainHandle('codex-read-plugin', async (_event, input: Omit<ProviderReadPluginInput, 'provider'>) => {
    ensureProviderService();
    return getProviderService().readPlugin({
      provider: 'codex',
      marketplacePath: input.marketplacePath,
      remoteMarketplaceName: input.remoteMarketplaceName,
      pluginName: input.pluginName,
    });
  });

  ipcMainHandle('get-opencode-model-config', async () => {
    return getOpencodeModelConfig();
  });

  ipcMainHandle('save-opencode-model-visibility', async (_event, enabledModels: string[]) => {
    return saveOpencodeModelVisibility(enabledModels);
  });

  ipcMainHandle('get-opencode-runtime-status', async () => {
    return getOpencodeRuntimeStatus();
  });

  ipcMainHandle('get-kimi-model-config', async () => {
    return getKimiModelConfig();
  });

  ipcMainHandle('get-kimi-runtime-status', async () => {
    return getKimiRuntimeStatus();
  });

  ipcMainHandle('get-grok-runtime-status', async () => {
    return getGrokRuntimeStatus();
  });

  ipcMainHandle('get-grok-model-config', async () => {
    return getGrokModelConfig();
  });

  ipcMainHandle('get-pi-model-config', async () => {
    return getPiModelConfig();
  });

  ipcMainHandle('get-claude-runtime-status', async (_event, model?: string | null) => {
    return getClaudeRuntimeStatus(model);
  });

  ipcMainHandle('get-skill-market-hot', async (_event, limit?: number) => {
    return getSkillMarketHot(limit);
  });

  ipcMainHandle('search-skill-market', async (_event, query: string, limit?: number) => {
    return searchSkillMarket(query, limit);
  });

  ipcMainHandle('get-skill-market-detail', async (_event, id: string) => {
    return getSkillMarketDetail(id);
  });

  ipcMainHandle('install-skill-from-market', async (_event, id: string) => {
    const result = await installSkillFromMarket(id);
    if (result.ok) {
      // A live Claude runner fixed its skill list at spawn; retire kept-alive
      // runners (doom busy ones) so `/<new-skill>` works on the next turn.
      // (The ipc/skill-market module registration shadows this handler and
      // does the same via ctx.onClaudeSkillsChanged — keep them in sync.)
      flushClaudeRunners();
    }
    return result;
  });

  ipcMainHandle(
    'expand-claude-skill-prompt',
    async (_event, skillFilePath: string, skillName: string, userPrompt: string) => {
      try {
        return {
          ok: true,
          prompt: expandClaudeSkillPrompt({
            skillFilePath,
            skillName,
            userPrompt,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMainHandle('get-feishu-bridge-config', async () => {
    return loadFeishuBridgeConfig();
  });

  ipcMainHandle('save-feishu-bridge-config', async (_event, config: FeishuBridgeConfig) => {
    return saveFeishuBridgeConfig(config);
  });

  ipcMainHandle('get-feishu-bridge-status', async () => {
    return feishuBridge.getStatus();
  });

  ipcMainHandle('get-memory-workspace', async (_event, projectCwd?: string | null) => {
    return getMemoryWorkspace(projectCwd);
  });

  ipcMainHandle('save-memory-document', async (_event, filePath: string, content: string) => {
    return saveMemoryDocument(filePath, content);
  });

  ipcMainHandle('start-feishu-bridge', async () => {
    return feishuBridge.start();
  });

  ipcMainHandle('stop-feishu-bridge', async () => {
    return feishuBridge.stop();
  });

  // RPC: 本机 agent 运行时检测目录(onboarding / provider 状态)
  ipcMainHandle('get-agent-runtime-directory', async (_event, force?: boolean) => {
    return getAgentRuntimeDirectory(force === true);
  });

  // RPC: 用户资料(展示名/handle,用于 Usage 档案头)
  ipcMainHandle('get-user-profile', async () => {
    return getUserProfile();
  });

  ipcMainHandle('save-user-profile', async (_event, update: UserProfileUpdate) => {
    return saveUserProfile(update);
  });

  // RPC: 获取字体设置
  ipcMainHandle('get-font-settings', async () => {
    return getFontSettings();
  });

  // RPC: 保存字体选择
  ipcMainHandle('save-font-selections', async (_event, selections: FontSettingsPayload['selections']) => {
    return saveFontSelections(selections);
  });

  // RPC: 列出系统字体
  ipcMainHandle('list-system-fonts', async () => {
    return listSystemFonts();
  });

  // RPC: 导入字体文件
  ipcMainHandle('import-font-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Fonts',
          extensions: ['ttf', 'otf', 'woff', 'woff2'],
        },
      ],
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return importFontFile(result.filePaths[0]);
  });

  // RPC: 删除导入字体
  ipcMainHandle('delete-imported-font', async (_event, fontId: string) => {
    return deleteImportedFont(fontId);
  });

  // RPC: 选择目录
  ipcMainHandle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // RPC: 选择附件（文件/图片）
  ipcMainHandle('select-attachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported',
          extensions: ['txt', 'md', 'json', 'log', 'pdf', 'docx', 'png', 'jpg', 'jpeg'],
        },
      ],
    });

    if (result.canceled) {
      return [] as Attachment[];
    }

    const attachments: Attachment[] = [];
    let skipped = 0;

    for (const filePath of result.filePaths) {
      const attachment = toAttachment(filePath);
      if (attachment) {
        attachments.push(attachment);
      } else {
        skipped += 1;
      }
    }

    if (skipped > 0) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Skipped ${skipped} file(s): only .txt/.md/.json/.log/.pdf/.docx/.png/.jpg are supported (<=10MB).`,
        },
      });
    }

    return attachments;
  });

  // RPC: 读取图片预览（data URL）
  ipcMainHandle('read-attachment-preview', async (_event, filePath: string) => {
    const spec = getAttachmentSpec(filePath);
    if (!spec || spec.kind !== 'image') {
      return null;
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
        return null;
      }
      const buffer = readFileSync(filePath);
      return `data:${spec.mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  // RPC: 将附件下载到系统 Downloads 目录，重名时自动添加序号。
  ipcMainHandle('download-attachment', async (_event, filePath: string, suggestedName?: string) => {
    const spec = getAttachmentSpec(filePath);
    if (!spec || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return { filePath: null, error: 'Attachment is no longer available.' };
    }

    const downloadsDir = app.getPath('downloads');
    const safeName = basename(suggestedName?.trim() || basename(filePath));
    const extension = extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;
    let targetPath = join(downloadsDir, safeName);
    let suffix = 2;
    while (existsSync(targetPath)) {
      targetPath = join(downloadsDir, `${stem} (${suffix})${extension}`);
      suffix += 1;
    }

    await fsPromises.copyFile(filePath, targetPath);
    return { filePath: targetPath };
  });

  // RPC: 获取项目文件树
  ipcMainHandle('get-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return null;
    }
    return readProjectTree(cwd);
  });

  ipcMainHandle('create-project-attachment', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) {
      return null;
    }

    return toProjectAttachment(cwd, filePath);
  });

  ipcMainHandle('create-project-file', async (_event, cwd: string, parentPath: string, name: string) => {
    return createProjectEntry(cwd, parentPath, name, 'file');
  });

  ipcMainHandle('create-project-folder', async (_event, cwd: string, parentPath: string, name: string) => {
    return createProjectEntry(cwd, parentPath, name, 'folder');
  });

  ipcMainHandle('move-project-entry', async (_event, cwd: string, sourcePath: string, targetParentPath: string) => {
    return moveProjectEntry(cwd, sourcePath, targetParentPath);
  });

  ipcMainHandle('delete-project-entry', async (_event, cwd: string, targetPath: string) => {
    return deleteProjectEntry(cwd, targetPath);
  });

  ipcMainHandle(
    'select-markdown-image-asset',
    async (
      _event,
      cwd: string,
      markdownFilePath: string
    ): Promise<{ ok: true; relativePath: string; name: string } | { ok: false; message: string } | null> => {
      if (!cwd || !markdownFilePath) {
        return { ok: false, message: 'Missing project or Markdown file path.' };
      }

      const resolvedMarkdown = resolve(cwd || '.', markdownFilePath || '');
      const markdownValidation = await validateProjectFilePath(cwd, resolvedMarkdown);
      if (!markdownValidation.ok) {
        return { ok: false, message: markdownValidation.message };
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      });

      if (result.canceled || !result.filePaths[0]) {
        return null;
      }

      const sourcePath = result.filePaths[0];
      const ext = extname(sourcePath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
        return { ok: false, message: 'Only image files can be inserted.' };
      }

      let sourceStat;
      try {
        sourceStat = await fsPromises.stat(sourcePath);
      } catch {
        return { ok: false, message: 'Selected image was not found.' };
      }

      if (!sourceStat.isFile()) {
        return { ok: false, message: 'Selected image is not a file.' };
      }
      if (sourceStat.size > MAX_ATTACHMENT_BYTES) {
        return { ok: false, message: 'Selected image is too large.' };
      }

      const markdownDir = resolve(markdownValidation.targetReal, '..');
      const markdownBase = basename(markdownValidation.targetReal).replace(/\.(md|markdown)$/i, '') || 'document';
      const assetDir = resolve(markdownDir, `${markdownBase}.assets`);
      if (!isPathWithinRoot(cwd, assetDir)) {
        return { ok: false, message: 'Image asset directory is outside the project.' };
      }

      const safeBaseName = basename(sourcePath, ext)
        .replace(/[^\w.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 72) || 'image';

      let fileName = `${safeBaseName}${ext}`;
      let targetPath = resolve(assetDir, fileName);
      let suffix = 2;
      while (existsSync(targetPath)) {
        fileName = `${safeBaseName}-${suffix}${ext}`;
        targetPath = resolve(assetDir, fileName);
        suffix += 1;
      }

      if (!isPathWithinRoot(cwd, targetPath)) {
        return { ok: false, message: 'Image asset target is outside the project.' };
      }

      try {
        await fsPromises.mkdir(assetDir, { recursive: true });
        await fsPromises.copyFile(sourcePath, targetPath);
      } catch (error) {
        return { ok: false, message: `Failed to copy image: ${String(error)}` };
      }

      const relativePath = relative(markdownDir, targetPath).replace(/\\/g, '/');
      return { ok: true, relativePath, name: fileName };
    }
  );

  ipcMainHandle(
    'read-markdown-image-asset',
    async (
      _event,
      cwd: string,
      markdownFilePath: string,
      imageSrc: string
    ): Promise<{ ok: true; dataUrl: string } | { ok: false; message: string }> => {
      return readMarkdownImageAsset(cwd, markdownFilePath, imageSrc);
    }
  );

  ipcMainHandle(
    'resolve-markdown-image-asset-url',
    async (
      _event,
      cwd: string,
      markdownFilePath: string,
      imageSrc: string
    ): Promise<{ ok: true; url: string; size: number; mtimeMs: number } | { ok: false; message: string }> => {
      return resolveMarkdownImageAssetUrl(cwd, markdownFilePath, imageSrc);
    }
  );

  ipcMainHandle(
    'create-markdown-image-asset',
    async (
      _event,
      cwd: string,
      markdownFilePath: string,
      fileName: string,
      mimeType: string | undefined,
      data: unknown
    ): Promise<{ ok: true; relativePath: string; name: string } | { ok: false; message: string }> => {
      return createMarkdownImageAsset(cwd, markdownFilePath, fileName, mimeType, data);
    }
  );

  ipcMainHandle('create-inline-text-attachment', async (_event, cwd: string, text: string) => {
    if (!cwd || typeof text !== 'string') {
      return null;
    }

    return createInlineTextAttachment(cwd, text);
  });

  // RPC: 把剪贴板中的图片（PNG/JPEG 二进制）写入临时文件并返回 Attachment
  ipcMainHandle(
    'create-inline-image-attachment',
    async (_event, mimeType: string, data: Uint8Array | ArrayBuffer) => {
      if (!mimeType || !data) {
        return null;
      }
      return createInlineImageAttachment(mimeType, data);
    }
  );

  // RPC: 读取项目文件预览（安全：仅允许 cwd 内的文件；PDF 走本地流式预览）
  ipcMainHandle(
    'read-project-file-preview',
    async (_event, cwd: string, filePath: string): Promise<ProjectFilePreview> => {
      const resolved = resolve(cwd || '.', filePath || '');
      const name = basename(resolved) || resolved;
      const ext = extname(resolved).toLowerCase();

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { kind: 'error', path: resolved, name, ext, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch (error) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'Not a file' };
      }

      if (ext === '.pdf') {
        if (stat.size > MAX_STREAMING_PDF_PREVIEW_BYTES) {
          return {
            kind: 'too_large',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            maxBytes: MAX_STREAMING_PDF_PREVIEW_BYTES,
          };
        }

        try {
          const preview = await getLocalPreviewUrl(validation.rootReal, validation.targetReal);
          if (!preview.ok) {
            return {
              kind: 'error',
              path: validation.targetReal,
              name,
              ext,
              message: preview.message,
            };
          }

          return {
            kind: 'pdf',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            previewUrl: preview.url,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to create PDF preview: ${String(error)}`,
          };
        }
      }

      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return {
          kind: 'too_large',
          path: validation.targetReal,
          name,
          ext,
          size: stat.size,
          maxBytes: MAX_FILE_PREVIEW_BYTES,
        };
      }

      // Images
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          const mimeType = ATTACHMENT_MIME_TYPES[ext] || 'application/octet-stream';
          return {
            kind: 'image',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read image: ${String(error)}`,
          };
        }
      }

      // Markdown + text-like preview
      if (
        ext === '.md' ||
        ext === '.mdx' ||
        ext === '.txt' ||
        ext === '.json' ||
        ext === '.log' ||
        ext === '.html' ||
        ext === '.htm' ||
        ext === '.css' ||
        ext === '.scss' ||
        ext === '.js' ||
        ext === '.jsx' ||
        ext === '.ts' ||
        ext === '.tsx' ||
        ext === '.yml' ||
        ext === '.yaml' ||
        ext === '.xml' ||
        ext === '.py' ||
        ext === '.rb' ||
        ext === '.go' ||
        ext === '.rs' ||
        ext === '.java' ||
        ext === '.kt' ||
        ext === '.swift' ||
        ext === '.sh' ||
        ext === '.sql' ||
        ext === '.toml' ||
        ext === '.ini'
      ) {
        try {
          const text = await fsPromises.readFile(validation.targetReal, 'utf8');
          return {
            // MDX must stay on the raw text path: the Markdown rich editor
            // serializes CommonMark/GFM and can rewrite MDX source.
            kind: ext === '.md' ? 'markdown' : ext === '.html' || ext === '.htm' ? 'html' : 'text',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            text,
            editable: ext === '.txt' || ext === '.md' || ext === '.mdx',
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read file: ${String(error)}`,
          };
        }
      }

      if (ext === '.csv' || ext === '.tsv') {
        try {
          const text = await fsPromises.readFile(validation.targetReal, 'utf8');
          return {
            kind: 'csv',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            text,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read file: ${String(error)}`,
          };
        }
      }

      if (ext === '.ppt' || ext === '.pptx' || ext === '.key') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          return {
            kind: 'pptx',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataBase64: buffer.toString('base64'),
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read presentation: ${String(error)}`,
          };
        }
      }

      if (ext === '.xlsx') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          return {
            kind: 'xlsx',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataBase64: buffer.toString('base64'),
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read workbook: ${String(error)}`,
          };
        }
      }

      // Binary files (open only). Legacy .xls is a binary format exceljs
      // cannot parse; route it to the system viewer instead of 'unsupported'.
      if (ext === '.docx' || ext === '.xls') {
        return { kind: 'binary', path: validation.targetReal, name, ext, size: stat.size };
      }

      return { kind: 'unsupported', path: validation.targetReal, name, ext, size: stat.size };
    }
  );

  // RPC: 写入项目文本文件（当前允许写 .txt / .md / .mdx，安全：cwd 内，<=5MB）
  ipcMainHandle(
    'write-project-text-file',
    async (
      _event,
      cwd: string,
      filePath: string,
      content: string
    ): Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; message: string }> => {
      const resolved = resolve(cwd || '.', filePath || '');
      const ext = extname(resolved).toLowerCase();

      if (ext !== '.txt' && ext !== '.md' && ext !== '.mdx') {
        return { ok: false, message: 'Only .txt, .md, and .mdx files are editable right now.' };
      }

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch {
        return { ok: false, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { ok: false, message: 'Not a file' };
      }

      const bytes = Buffer.byteLength(content ?? '', 'utf8');
      if (bytes > MAX_FILE_PREVIEW_BYTES) {
        return { ok: false, message: 'File content is too large to save (max 5MB).' };
      }

      try {
        await writeTextFileAtomic(validation.targetReal, content ?? '', stat.mode);
        const savedStat = await fsPromises.stat(validation.targetReal);
        return { ok: true, size: savedStat.size, mtimeMs: savedStat.mtimeMs };
      } catch (error) {
        return { ok: false, message: `Failed to save file: ${String(error)}` };
      }
    }
  );

  // RPC: 用系统默认应用打开文件
  ipcMainHandle('open-path', async (_event, filePath: string) => {
    try {
      const errMsg = await shell.openPath(normalizeShellPath(filePath));
      return errMsg ? { ok: false, message: errMsg } : { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  ipcMainHandle(
    'preview-artifact-path',
    async (
      _event,
      cwd: string,
      filePath: string,
      _options?: { openInBrowser?: boolean }
    ): Promise<{ ok: boolean; url?: string; message?: string }> => {
      // HTML artifact previews are routed to the in-app browser panel from the
      // renderer. This handler only resolves the local preview server URL — it
      // must NOT open the system default browser, even if a legacy caller still
      // passes `{ openInBrowser: true }`. Callers that genuinely need to open a
      // URL externally should invoke `open-external-url` explicitly.
      try {
        const preview = await getHtmlPreviewUrl(cwd, filePath);
        if (!preview.ok) {
          return preview;
        }
        return { ok: true, url: preview.url };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    }
  );

  // RPC: 在文件管理器中展示文件
  ipcMainHandle('reveal-path', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(normalizeShellPath(filePath));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // RPC: 列出可以打开该文件的本地应用（"打开方式"）。仅 macOS 支持。
  ipcMainHandle(
    'list-open-with-apps',
    async (
      _event,
      cwd: string,
      filePath: string
    ): Promise<{ ok: boolean; apps?: OpenWithApp[]; message?: string }> => {
      if (process.platform !== 'darwin') {
        // Feature is macOS-only (Launch Services). Renderer hides the button
        // when the list comes back empty.
        return { ok: true, apps: [] };
      }
      const validation = await validateProjectFilePath(cwd, filePath);
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }
      try {
        const apps = await listOpenWithApps(validation.targetReal);
        return { ok: true, apps };
      } catch (error) {
        // Launch Services / osascript failures degrade to an empty list, not
        // an error toast — the feature simply hides.
        return { ok: true, apps: [] };
      }
    }
  );

  // RPC: 用指定应用打开文件（"打开方式 › 某个 App"）。
  ipcMainHandle(
    'open-file-with-app',
    async (
      _event,
      cwd: string,
      filePath: string,
      appPath: string
    ): Promise<{ ok: boolean; message?: string }> => {
      if (process.platform !== 'darwin') {
        return { ok: false, message: 'Open-with is only supported on macOS.' };
      }
      const validation = await validateProjectFilePath(cwd, filePath);
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }
      if (typeof appPath !== 'string' || !appPath.toLowerCase().endsWith('.app')) {
        return { ok: false, message: 'Invalid application path.' };
      }
      try {
        // Pass path + app via argv, never string interpolation, so spaces and
        // shell metacharacters in the file/app path can't break out.
        await execFileAsync('open', ['-a', appPath, validation.targetReal]);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    }
  );

  // RPC: 订阅项目文件树更新
  ipcMainHandle('watch-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return false;
    }
    if (!(await isReadableDirectory(cwd))) {
      closeProjectTreeWatcher(cwd);
      return false;
    }
    if (projectWatchers.has(cwd)) {
      scheduleProjectTree(mainWindow, cwd);
      return true;
    }
    try {
      const watcher = watch(
        cwd,
        { recursive: true },
        () => scheduleProjectTree(mainWindow, cwd)
      );
      projectWatchers.set(cwd, { watcher });
      scheduleProjectTree(mainWindow, cwd);
      return true;
    } catch (error) {
      console.error('Failed to watch project tree:', error);
      return false;
    }
  });

  // RPC: 取消订阅项目文件树更新
  ipcMainHandle('unwatch-project-tree', async (_event, cwd: string) => {
    closeProjectTreeWatcher(cwd);
    return true;
  });

  // RPC: 订阅单个可编辑文件的磁盘变化（用于编辑器同步外部改动）
  ipcMainHandle('watch-project-file', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) {
      return false;
    }
    const resolved = resolve(cwd, filePath);
    const ext = extname(resolved).toLowerCase();
    if (ext !== '.md' && ext !== '.mdx' && ext !== '.txt') {
      return false;
    }
    const validation = await validateProjectFilePath(cwd, resolved);
    if (!validation.ok) {
      return false;
    }

    const key = projectFileWatchKey(cwd, filePath);
    const base = basename(resolved);
    // Close any stale watcher pointing at a different file under the same key bucket.
    const existing = projectFileWatchers.get(key);
    if (existing) {
      return true;
    }

    try {
      // Watch the parent directory (not the file) so atomic saves that rename
      // the file into place still surface changes.
      const watcher = watch(dirname(resolved), (_eventType, changed) => {
        if (changed && basename(String(changed)) !== base) return;
        scheduleProjectFile(mainWindow, key);
      });
      projectFileWatchers.set(key, { watcher, cwd, filePath, base });
      return true;
    } catch (error) {
      console.error('Failed to watch project file:', error);
      return false;
    }
  });

  // RPC: 取消订阅单个文件的磁盘变化
  ipcMainHandle('unwatch-project-file', async (_event, cwd: string, filePath: string) => {
    closeProjectFileWatcher(projectFileWatchKey(cwd, filePath));
    return true;
  });

  // ── Git Changes ──

  ipcMainHandle('get-git-changes', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, error: 'no-cwd', entries: [] };

    // Check if inside a git repo first
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return { ok: false, error: 'not-a-repo', entries: [] };
    }

    try {
      const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '-z'], {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      const entries = parseGitStatusEntries(stdout);
      return { ok: true, error: null, entries };
    } catch {
      return { ok: false, error: 'git-error', entries: [] };
    }
  });

  ipcMainHandle('git-generate-commit-message', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, message: 'Missing cwd.' };

    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return { ok: false, message: 'Current folder is not a git repository.' };
    }

    try {
      const statusResult = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '-z'], {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      const entries = parseGitStatusEntries(statusResult.stdout);
      if (entries.length === 0) {
        return { ok: false, message: 'No local changes to summarize.' };
      }

      const [stagedDiff, unstagedDiff] = await Promise.all([
        execFileAsync('git', ['diff', '--cached', '--unified=0', '--'], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        }),
        execFileAsync('git', ['diff', '--unified=0', '--'], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        }),
      ]);
      const diffText = `${stagedDiff.stdout}\n${unstagedDiff.stdout}`;

      return {
        ok: true,
        message: generateCommitMessageFromGitChanges(entries, diffText),
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to generate commit message.',
      };
    }
  });

  ipcMainHandle('get-git-working-tree-summary', async (_event, cwd: string) => {
    if (!cwd) {
      return { ok: false, error: 'no-cwd', insertions: 0, deletions: 0 };
    }

    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return { ok: false, error: 'not-a-repo', insertions: 0, deletions: 0 };
    }

    try {
      const [trackedDiff, untrackedFiles] = await Promise.all([
        execFileAsync('git', ['diff', '--numstat', 'HEAD', '--'], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        }),
        execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        }),
      ]);

      let { insertions, deletions } = parseGitNumstat(trackedDiff.stdout);
      const untrackedPaths = untrackedFiles.stdout.split('\0').map((item) => item.trim()).filter(Boolean);

      for (const filePath of untrackedPaths) {
        try {
          await execFileAsync('git', ['diff', '--no-index', '--numstat', '/dev/null', filePath], {
            cwd,
            timeout: 10000,
            maxBuffer: 2 * 1024 * 1024,
          });
        } catch (error: unknown) {
          const stdout =
            error && typeof error === 'object' && 'stdout' in error
              ? String((error as { stdout?: unknown }).stdout ?? '')
              : '';
          const stats = parseGitNumstat(stdout);
          insertions += stats.insertions;
          deletions += stats.deletions;
        }
      }

      return { ok: true, error: null, insertions, deletions };
    } catch {
      return { ok: false, error: 'git-error', insertions: 0, deletions: 0 };
    }
  });

  ipcMainHandle('get-git-overview', async (_event, cwd: string) => {
    if (!cwd) {
      return {
        ok: false,
        error: 'no-cwd',
        hasRepo: false,
        repoRoot: null,
        repository: null,
        branch: null,
        upstream: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        hasOriginRemote: false,
        isGitHubRemote: false,
        isDefaultBranch: false,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        prStatus: 'not_found',
        pr: null,
      };
    }

    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return {
        ok: false,
        error: 'not-a-repo',
        hasRepo: false,
        repoRoot: null,
        repository: null,
        branch: null,
        upstream: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        hasOriginRemote: false,
        isGitHubRemote: false,
        isDefaultBranch: false,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        prStatus: 'not_found',
        pr: null,
      };
    }

    try {
      const [summary, branchResult, changesResult, originRemote, upstreamRef, defaultBranch, repoRoot] =
        await Promise.all([
          (async () => {
            const [trackedDiff, untrackedFiles] = await Promise.all([
              execFileAsync('git', ['diff', '--numstat', 'HEAD', '--'], {
                cwd,
                timeout: 10000,
                maxBuffer: 2 * 1024 * 1024,
              }),
              execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
                cwd,
                timeout: 10000,
                maxBuffer: 2 * 1024 * 1024,
              }),
            ]);

            let totals = parseGitNumstat(trackedDiff.stdout);
            const untrackedPaths = untrackedFiles.stdout.split('\0').map((item) => item.trim()).filter(Boolean);
            for (const filePath of untrackedPaths) {
              try {
                await execFileAsync('git', ['diff', '--no-index', '--numstat', '/dev/null', filePath], {
                  cwd,
                  timeout: 10000,
                  maxBuffer: 2 * 1024 * 1024,
                });
              } catch (error: unknown) {
                const stdout =
                  error && typeof error === 'object' && 'stdout' in error
                    ? String((error as { stdout?: unknown }).stdout ?? '')
                    : '';
                const stats = parseGitNumstat(stdout);
                totals = {
                  insertions: totals.insertions + stats.insertions,
                  deletions: totals.deletions + stats.deletions,
                };
              }
            }

            return totals;
          })(),
          execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
          execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '-z'], {
            cwd,
            maxBuffer: 1024 * 1024,
            timeout: 10000,
          }),
          getGitOriginRemote(cwd),
          getGitUpstreamRef(cwd),
          getGitDefaultBranch(cwd),
          getGitTopLevel(cwd).catch(() => null),
        ]);

      const branch = branchResult.stdout.trim() || 'HEAD';
      const hasOriginRemote = !!originRemote;
      const originRepo = originRemote ? parseGitHubRepoFromRemote(originRemote) : null;
      const isGitHubRemote = !!originRepo;
      const hasUpstream = !!upstreamRef;
      const { aheadCount, behindCount } = await getGitAheadBehindCounts(cwd, upstreamRef);
      const prLookup = await getGitPullRequestInfo({ cwd, branch, originRepo });
      const repository = {
        root: repoRoot || null,
        originUrl: originRemote,
        owner: originRepo?.owner || null,
        name: originRepo?.repo || null,
        fullName: originRepo ? `${originRepo.owner}/${originRepo.repo}` : null,
        webUrl: originRepo ? `https://github.com/${originRepo.owner}/${originRepo.repo}` : null,
        defaultBranch: defaultBranch || null,
      };

      return {
        ok: true,
        error: null,
        hasRepo: true,
        repoRoot: repoRoot || null,
        repository,
        branch,
        upstream: upstreamRef,
        hasUpstream,
        aheadCount,
        behindCount,
        hasOriginRemote,
        isGitHubRemote,
        isDefaultBranch: !!defaultBranch && branch === defaultBranch,
        totalChanges: parseGitStatusEntries(changesResult.stdout).length,
        insertions: summary.insertions,
        deletions: summary.deletions,
        prStatus: prLookup.status,
        pr: prLookup.pr,
      };
    } catch {
      return {
        ok: false,
        error: 'git-error',
        hasRepo: false,
        repoRoot: null,
        repository: null,
        branch: null,
        upstream: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        hasOriginRemote: false,
        isGitHubRemote: false,
        isDefaultBranch: false,
        totalChanges: 0,
        insertions: 0,
        deletions: 0,
        prStatus: 'unknown',
        pr: null,
      };
    }
  });

  ipcMainHandle('get-git-patch', async (_event, cwd: string, scopeInput?: unknown): Promise<GitPatchResult> => {
    const scope = normalizeGitPatchScope(scopeInput);
    if (!cwd) {
      return {
        ok: false,
        error: 'no-cwd',
        scope,
        patch: '',
        repoRoot: null,
        truncated: false,
      };
    }

    let repoRoot: string | null = null;
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
      repoRoot = await getGitTopLevel(cwd).catch(() => null);
    } catch {
      return {
        ok: false,
        error: 'not-a-repo',
        scope,
        patch: '',
        repoRoot: null,
        truncated: false,
      };
    }

    try {
      if (scope === 'staged') {
        const patch = await runGitDiff(cwd, ['--cached', '--']);
        return normalizePatchResult(scope, patch, repoRoot);
      }

      if (scope === 'branch') {
        const baseRef = (await getGitUpstreamRef(cwd)) || (await getGitDefaultBranch(cwd));
        if (!baseRef) {
          return {
            ok: false,
            error: 'branch-base-unavailable',
            scope,
            patch: '',
            repoRoot,
            baseRef: null,
            truncated: false,
          };
        }
        const patch = await runGitDiff(cwd, [`${baseRef}...HEAD`, '--']);
        return normalizePatchResult(scope, patch, repoRoot, baseRef);
      }

      const unstagedPatch = await runGitDiff(cwd, ['--']);
      const untrackedPatch = await getUntrackedPatch(cwd);
      if (scope === 'unstaged') {
        return normalizePatchResult(
          scope,
          [unstagedPatch, untrackedPatch].filter((patch) => patch.trim()).join('\n'),
          repoRoot
        );
      }

      const stagedPatch = await runGitDiff(cwd, ['--cached', '--']);
      return normalizePatchResult(
        scope,
        [stagedPatch, unstagedPatch, untrackedPatch].filter((patch) => patch.trim()).join('\n'),
        repoRoot
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'git-error',
        scope,
        patch: '',
        repoRoot,
        truncated: false,
      };
    }
  });

  ipcMainHandle('get-git-diff', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) return '';
    try {
      // Unstaged
      const unstaged = await execFileAsync('git', ['diff', '--unified=3', '--', filePath], {
        cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
      });
      if (unstaged.stdout.trim()) return unstaged.stdout;

      // Staged
      const staged = await execFileAsync('git', ['diff', '--cached', '--unified=3', '--', filePath], {
        cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
      });
      if (staged.stdout.trim()) return staged.stdout;

      // Untracked (diff against /dev/null)
      try {
        const untracked = await execFileAsync('git', ['diff', '--no-index', '--unified=3', '/dev/null', filePath], {
          cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
        });
        return untracked.stdout;
      } catch (err: unknown) {
        // git diff --no-index exits 1 when differences exist
        if (err && typeof err === 'object' && 'stdout' in err) return (err as { stdout: string }).stdout;
      }
      return '';
    } catch {
      return '';
    }
  });

  ipcMainHandle('get-git-branch', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, branch: null, message: 'no-cwd' };
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd,
        timeout: 5000,
      });
      return { ok: true, branch: stdout.trim() || 'HEAD' };
    } catch (error) {
      return {
        ok: false,
        branch: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const normalizeGitCheckoutInput = (
    input: GitCheckoutBranchInput | string,
    branchArg?: string
  ): GitCheckoutBranchInput => {
    if (typeof input === 'string') {
      return { cwd: input, branch: branchArg || '' };
    }
    return input;
  };

  // Busy means the DB says 'running'. Runner-handle presence is NOT a busy
  // signal: handles persist between turns for connection reuse (all providers,
  // including Claude), so keying gates on the map would block git/workspace
  // actions from perfectly idle sessions.
  const getRunningSessionRows = (): Array<NonNullable<ReturnType<typeof sessions.getSession>>> =>
    sessions.listRunningSessions();

  const findRunningSessionSharingGitRoot = async (
    cwd: string,
    excludedSessionId?: string | null
  ): Promise<NonNullable<ReturnType<typeof sessions.getSession>> | null> => {
    const targetRoot = resolve(await getGitTopLevel(cwd));
    for (const row of getRunningSessionRows()) {
      if (excludedSessionId && row.id === excludedSessionId) {
        continue;
      }
      const rowCwd = row.cwd || row.project_cwd;
      if (!rowCwd) {
        continue;
      }
      try {
        const rowRoot = resolve(await getGitTopLevel(rowCwd));
        if (rowRoot === targetRoot) {
          return row;
        }
      } catch {
        continue;
      }
    }
    return null;
  };

  // A branch mutation rewrites the files under every session cwd sharing the
  // git root. Kept-alive runners (any provider) hold live context and file
  // state from the pre-mutation checkout — retire them so the next turn
  // spawns fresh against the new checkout. The mutation gate already ensured
  // none of these sessions is running.
  const flushRunnersSharingGitRoot = async (cwd: string): Promise<void> => {
    let targetRoot: string;
    try {
      targetRoot = resolve(await getGitTopLevel(cwd));
    } catch {
      return;
    }
    for (const sessionId of Array.from(runnerHandles.keys())) {
      const row = sessions.getSession(sessionId);
      const rowCwd = row?.cwd || row?.project_cwd;
      if (!rowCwd) continue;
      try {
        if (resolve(await getGitTopLevel(rowCwd)) === targetRoot) {
          retireSessionRunner(sessionId);
        }
      } catch {
        continue;
      }
    }
  };

  const getGitBranchMutationBlockMessage = async (
    cwd: string,
    sessionId?: string | null
  ): Promise<string | null> => {
    const session = sessionId ? sessions.getSession(sessionId) : null;
    if (session && session.status === 'running') {
      return 'Stop the current task before switching branches.';
    }

    const blockingSession = await findRunningSessionSharingGitRoot(cwd, sessionId || null);
    if (blockingSession) {
      return `Another running session is using this workspace: ${blockingSession.title || blockingSession.id}. Open a worktree/new thread or wait for it to finish before switching branches.`;
    }

    return null;
  };

  ipcMainHandle('get-git-branches', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, error: 'no-cwd', detachedHead: false, headShortHash: null, entries: [] };

    try {
      const { detachedHead, headShortHash, entries } = await listGitBranches(cwd);
      return { ok: true, error: null, detachedHead, headShortHash, entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/i.test(message)) {
        return { ok: false, error: 'not-a-repo', detachedHead: false, headShortHash: null, entries: [] };
      }
      return { ok: false, error: 'git-error', detachedHead: false, headShortHash: null, entries: [] };
    }
  });

  ipcMainHandle('git-checkout-branch', async (_event, rawInput: GitCheckoutBranchInput | string, branchArg?: string) => {
    const input = normalizeGitCheckoutInput(rawInput, branchArg);
    const cwd = input.cwd?.trim();
    const branch = input.branch?.trim();
    if (!cwd || !branch) {
      return { ok: false, message: 'Branch checkout requires a workspace and branch.' };
    }
    try {
      const blockMessage = await getGitBranchMutationBlockMessage(cwd, input.sessionId || null);
      if (blockMessage) {
        return { ok: false, message: blockMessage };
      }
      await flushRunnersSharingGitRoot(cwd);

      const output = await checkoutBranch({ cwd, branch });
      return { ok: true, output };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainHandle('git-create-branch', async (_event, input: GitCreateBranchInput) => {
    const cwd = input.cwd?.trim();
    const branch = input.branch?.trim();
    if (!cwd || !branch) {
      return { ok: false, message: 'Creating a branch requires a workspace and branch name.' };
    }
    try {
      const blockMessage = await getGitBranchMutationBlockMessage(cwd, input.sessionId || null);
      if (blockMessage) {
        return { ok: false, message: blockMessage };
      }
      await flushRunnersSharingGitRoot(cwd);

      const output = await createBranch({ cwd, branch });
      return { ok: true, output };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainHandle('git-create-worktree', async (_event, input: GitCreateWorktreeInput) => {
    const cwd = input.cwd?.trim();
    const branch = input.branch?.trim();
    if (!cwd || !branch) {
      return { ok: false, message: 'Creating a worktree requires a workspace and branch.', worktree: null };
    }
    try {
      const worktree = await createWorktree({
        cwd,
        branch,
        newBranch: input.newBranch ?? null,
        path: input.path ?? null,
      });
      return { ok: true, worktree };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), worktree: null };
    }
  });

  ipcMainHandle(
    'git-session-handoff',
    async (_event, input: GitSessionHandoffInput) => {
      const session = sessions.getSession(input.sessionId);
      if (!session) return { ok: false, message: 'Unknown session.' };
      const projectCwd = session.project_cwd || session.cwd;
      if (!projectCwd) return { ok: false, message: 'Session has no project folder.' };
      const broadcastWorkspaceStatus = (updated: ReturnType<typeof sessions.getSession>) => {
        if (!updated) return;
        broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId: updated.id,
            status: updated.status as SessionStatus,
            cwd: updated.cwd || undefined,
            projectCwd: updated.project_cwd || updated.cwd || null,
            envMode: updated.env_mode === 'worktree' ? 'worktree' : 'local',
            worktreePath: updated.worktree_path || null,
            associatedWorktreePath: updated.associated_worktree_path || null,
            associatedWorktreeBranch: updated.associated_worktree_branch || null,
            associatedWorktreeRef: updated.associated_worktree_ref || null,
          },
        });
      };
      try {
        if (session.status === 'running') {
          return { ok: false, message: 'Stop the current task before switching workspaces.' };
        }
        // The handoff changes this session's workspace (cwd). A kept-alive
        // runner (any provider) captured the old cwd at spawn and must not
        // serve another turn against the wrong checkout.
        retireSessionRunner(input.sessionId);

        if (input.targetMode === 'local') {
          const sourceCwd = session.worktree_path || session.cwd || projectCwd;
          const sourceIsWorktree = resolve(sourceCwd) !== resolve(projectCwd);
          const includeChanges = input.includeChanges === true;
          const targetBranch = input.branch?.trim() || null;

          if (!includeChanges && !targetBranch) {
            sessions.updateSessionWorkspace(input.sessionId, {
              projectCwd,
              envMode: 'local',
              worktreePath: null,
            });
            const updated = sessions.getSession(input.sessionId);
            broadcastWorkspaceStatus(updated);
            return { ok: true, session: updated, worktree: null };
          }

          let sourceStash: { created: boolean; stashSha: string | null; output: string } = {
            created: false,
            stashSha: null,
            output: '',
          };
          let localStash: { created: boolean; stashSha: string | null; output: string } = {
            created: false,
            stashSha: null,
            output: '',
          };
          try {
            const currentLocalBranch = targetBranch
              ? await getCurrentBranch(projectCwd).catch(() => null)
              : null;
            const willCheckoutLocalBranch = Boolean(targetBranch && currentLocalBranch !== targetBranch);
            if (includeChanges || willCheckoutLocalBranch) {
              const blockingSession = await findRunningSessionSharingGitRoot(projectCwd, input.sessionId);
              if (blockingSession) {
                throw new Error(`Another running session is using the local workspace: ${blockingSession.title || blockingSession.id}.`);
              }
              // The stash-apply and/or branch checkout below rewrite files in
              // the project checkout; idle kept-alive runners of OTHER
              // sessions anchored there must not serve another turn against
              // the mutated files — same invariant as git-checkout-branch.
              await flushRunnersSharingGitRoot(projectCwd);
            }
            sourceStash = includeChanges && sourceIsWorktree
              ? await stashWorkingTree({
                  cwd: sourceCwd,
                  message: `Aegis handoff to local ${new Date().toISOString()}`,
                })
              : sourceStash;
            localStash = includeChanges
              ? await stashWorkingTree({
                  cwd: projectCwd,
                  message: `Aegis preserve local workspace ${new Date().toISOString()}`,
                })
              : localStash;
            if (targetBranch) {
              if (currentLocalBranch !== targetBranch) {
                await checkoutBranch({ cwd: projectCwd, branch: targetBranch });
              }
            }
            if (sourceStash.created && sourceStash.stashSha) {
              await applyStash({ cwd: projectCwd, stashSha: sourceStash.stashSha });
            }
            if (localStash.created && localStash.stashSha) {
              await applyStash({ cwd: projectCwd, stashSha: localStash.stashSha });
            }
            sessions.updateSessionWorkspace(input.sessionId, {
              projectCwd,
              envMode: 'local',
              worktreePath: null,
            });
            const updated = sessions.getSession(input.sessionId);
            broadcastWorkspaceStatus(updated);
            if (sourceStash.created && sourceStash.stashSha) {
              await dropStash({ cwd: sourceCwd, stashSha: sourceStash.stashSha }).catch(() => undefined);
            }
            if (localStash.created && localStash.stashSha) {
              await dropStash({ cwd: projectCwd, stashSha: localStash.stashSha }).catch(() => undefined);
            }
            return { ok: true, session: updated, worktree: null };
          } catch (error) {
            const preserved = [
              sourceStash.created && sourceStash.stashSha
                ? `worktree changes: ${sourceStash.stashSha}`
                : null,
              localStash.created && localStash.stashSha
                ? `local changes: ${localStash.stashSha}`
                : null,
            ].filter(Boolean);
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Unable to bring changes to Local.${preserved.length > 0 ? ` Preserved stash refs: ${preserved.join(', ')}.` : ''}${detail ? `\n\n${detail}` : ''}`
            );
          }
        }
        const sourceCwd = session.cwd || projectCwd;
        const includeChanges = input.includeChanges === true;
        let sourceStash: { created: boolean; stashSha: string | null; output: string } = {
          created: false,
          stashSha: null,
          output: '',
        };
        let createdWorktreePath: string | null = null;
        let worktree: Awaited<ReturnType<typeof createWorktree>> | null = null;
        try {
          sourceStash = includeChanges
            ? await stashWorkingTree({
                cwd: sourceCwd,
                message: `Aegis handoff to worktree ${new Date().toISOString()}`,
              })
            : sourceStash;
          const branch = input.branch || (await getCurrentBranch(projectCwd)) || 'HEAD';
          const defaultNewBranch =
            branch === 'HEAD'
              ? `aegis/worktree-${Date.now().toString(36)}`
              : `aegis/${branch.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/[\\/]+/g, '-')}-${Date.now().toString(36)}`;
          const newBranch = input.newBranch?.trim() || defaultNewBranch;
          worktree = input.worktreePath
            ? {
                path: input.worktreePath,
                branch: (await getCurrentBranch(input.worktreePath).catch(() => null)) || newBranch || branch,
                head: null,
                detached: false,
                locked: false,
                prunable: false,
                current: false,
              }
            : await createWorktree({
                cwd: projectCwd,
                branch,
                newBranch,
              });
          if (!input.worktreePath) {
            createdWorktreePath = worktree.path;
          }
          if (sourceStash.created && sourceStash.stashSha) {
            await applyStash({ cwd: worktree.path, stashSha: sourceStash.stashSha });
          }
          sessions.updateSessionWorkspace(input.sessionId, {
            projectCwd,
            envMode: 'worktree',
            worktreePath: worktree.path,
            associatedWorktreePath: worktree.path,
            associatedWorktreeBranch: worktree.branch || newBranch || branch,
            associatedWorktreeRef: worktree.branch || newBranch || branch,
          });
          const updated = sessions.getSession(input.sessionId);
          broadcastWorkspaceStatus(updated);
          if (sourceStash.created && sourceStash.stashSha) {
            await dropStash({ cwd: sourceCwd, stashSha: sourceStash.stashSha }).catch(() => undefined);
          }
          return { ok: true, session: updated, worktree };
        } catch (error) {
          const preserved = sourceStash.created && sourceStash.stashSha
            ? `current changes: ${sourceStash.stashSha}`
            : null;
          if (preserved) {
            await applyStash({ cwd: sourceCwd, stashSha: sourceStash.stashSha! }).catch(() => undefined);
          }
          if (createdWorktreePath) {
            await removeWorktree({ cwd: projectCwd, path: createdWorktreePath, force: true }).catch(() => undefined);
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Unable to bring current changes into the worktree.${preserved ? ` Preserved stash refs: ${preserved}.` : ''} The new worktree was cancelled when possible.${detail ? `\n\n${detail}` : ''}`
          );
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMainHandle('get-git-history', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, error: 'no-cwd', entries: [] };

    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return { ok: false, error: 'not-a-repo', entries: [] };
    }

    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'log',
          '--max-count=12',
          '--date=iso-strict',
          '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%ar%x1f%s%x1e',
        ],
        {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        }
      );

      const entries = stdout
        .split('\x1e')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, shortHash, authorName, authoredAt, relativeTime, subject] = record.split('\x1f');
          return {
            hash: hash?.trim() || '',
            shortHash: shortHash?.trim() || '',
            authorName: authorName?.trim() || 'Unknown author',
            authoredAt: authoredAt?.trim() || '',
            relativeTime: relativeTime?.trim() || '',
            subject: subject?.trim() || '(no commit message)',
          };
        })
        .filter((entry) => entry.hash && entry.shortHash);

      return { ok: true, error: null, entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not have any commits yet|your current branch .* does not have any commits yet/i.test(message)) {
        return { ok: true, error: null, entries: [] };
      }
      return { ok: false, error: 'git-error', entries: [] };
    }
  });

  ipcMainHandle('git-stage-path', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) return { ok: false, message: 'Missing cwd or file path.' };
    try {
      await execFileAsync('git', ['add', '--', filePath], {
        cwd,
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainHandle('git-unstage-path', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) return { ok: false, message: 'Missing cwd or file path.' };
    try {
      await execFileAsync('git', ['restore', '--staged', '--', filePath], {
        cwd,
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { ok: true };
    } catch {
      try {
        await execFileAsync('git', ['reset', 'HEAD', '--', filePath], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
  });

  ipcMainHandle('git-discard-path', async (_event, cwd: string, filePath: string, status?: string) => {
    if (!cwd || !filePath) return { ok: false, message: 'Missing cwd or file path.' };

    try {
      if (status === '?') {
        await execFileAsync('git', ['clean', '-f', '--', filePath], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return { ok: true };
      }

      try {
        await execFileAsync('git', ['restore', '--staged', '--worktree', '--', filePath], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
      } catch {
        await execFileAsync('git', ['reset', 'HEAD', '--', filePath], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
        await execFileAsync('git', ['checkout', '--', filePath], {
          cwd,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        });
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMainHandle('git-commit', async (_event, cwd: string, message: string) => {
    const trimmed = message.trim();
    if (!cwd || !trimmed) return { ok: false, message: 'Commit message cannot be empty.' };
    try {
      const { stdout, stderr } = await execFileAsync('git', ['commit', '-m', trimmed], {
        cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
      return { ok: false, message: combined || 'git commit failed.' };
    }
  });

  ipcMainHandle('git-push', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, message: 'Missing cwd.' };
    try {
      let pushArgs = ['push'];
      let hasUpstream = false;

      try {
        const { stdout: upstreamStdout } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          {
            cwd,
            timeout: 5000,
          }
        );
        const upstreamRef = upstreamStdout.trim();
        const upstreamMatch = upstreamRef.match(/^([^/]+)\/(.+)$/);
        if (upstreamMatch) {
          hasUpstream = true;
          const [, remoteName, remoteBranchName] = upstreamMatch;
          pushArgs = ['push', remoteName, `HEAD:${remoteBranchName}`];
        }
      } catch {
        hasUpstream = false;
      }

      if (!hasUpstream) {
        const [{ stdout: branchStdout }, originRemote] = await Promise.all([
          execFileAsync('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
          getGitOriginRemote(cwd),
        ]);
        const branch = branchStdout.trim();
        if (!originRemote) {
          return { ok: false, message: 'No origin remote is configured for this repository.' };
        }
        if (!branch || branch === 'HEAD') {
          return { ok: false, message: 'Cannot publish a detached HEAD. Create or checkout a branch first.' };
        }
        pushArgs = ['push', '-u', 'origin', `HEAD:${branch}`];
      }

      const { stdout, stderr } = await execFileAsync('git', pushArgs, {
        cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
      return { ok: false, message: combined || 'git push failed.' };
    }
  });

  ipcMainHandle('git-sync', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, message: 'Missing cwd.' };
    try {
      const { stdout, stderr } = await execFileAsync('git', ['pull', '--ff-only'], {
        cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
      return { ok: false, message: combined || 'git sync failed.' };
    }
  });

  ipcMainHandle('git-create-pr', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, message: 'Missing cwd.' };
    try {
      const { stdout, stderr } = await execFileAsync('gh', ['pr', 'create', '--fill'], {
        cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const combined = `${stdout}\n${stderr}`.trim();
      const url = combined
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+$/i.test(line));
      if (!url) {
        return { ok: false, message: combined || 'gh pr create did not return a pull request URL.' };
      }
      return { ok: true, url };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const combined = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
      return { ok: false, message: combined || 'gh pr create failed.' };
    }
  });

  ipcMainHandle('get-environment-editor-launchers', async () => {
    return getEnvironmentEditorLaunchers();
  });

  ipcMainHandle('open-in-editor', async (_event, input: OpenInEditorInput) => {
    return openInEnvironmentEditor(input);
  });

  ipcMainHandle('get-session-environment-context', async (_event, sessionId: string) => {
    const session = sessionId ? sessions.getSession(sessionId) : null;
    if (!session) {
      return { ok: false, message: 'Session not found.' };
    }
    return {
      ok: true,
      context: {
        sessionId,
        note: sessions.getSessionEnvironmentNote(sessionId),
        recap: sessions.getSessionEnvironmentRecap(sessionId),
      },
    };
  });

  ipcMainHandle('save-session-environment-note', async (_event, sessionId: string, note: string) => {
    const session = sessionId ? sessions.getSession(sessionId) : null;
    if (!session) {
      return { ok: false, message: 'Session not found.' };
    }
    const safeNote = String(note ?? '').slice(0, 8000);
    return {
      ok: true,
      note: sessions.saveSessionEnvironmentNote(sessionId, safeNote),
    };
  });

  ipcMainHandle('refresh-session-environment-recap', async (_event, sessionId: string) => {
    const session = sessionId ? sessions.getSession(sessionId) : null;
    if (!session) {
      return { ok: false, message: 'Session not found.' };
    }
    try {
      const recap = await refreshSessionEnvironmentRecapDeduped(session, mainWindow);
      return { ok: true, recap };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  ipcMainHandle('open-external-url', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // === IPC 模块注册（从 ipc-handlers.ts 拆分） ===
  const ipcCtx: any = {
    mainWindow,
    localPreviewServers,
    runnerHandles,
    sessionStates,
    broadcast,
    broadcastFolderChanged,
    ATTACHMENT_MIME_TYPES,
    LOCAL_PREVIEW_MIME_TYPES,
    // Skill installs change what a Claude CLI process loaded at spawn;
    // kept-alive runners must be retired so the next turn sees the new skill.
    onClaudeSkillsChanged: () => flushClaudeRunners(),
  }
  registerTerminal(ipcCtx)
  registerFeishu(ipcCtx)
  registerPromptLibrary(ipcCtx)
  registerFont(ipcCtx)
  registerMemory(ipcCtx)
  registerSkillMarket(ipcCtx)
}

// 处理客户端事件
async function handleClientEvent(
  mainWindow: BrowserWindow,
  event: ClientEvent
): Promise<void> {
  switch (event.type) {
    case 'session.list':
      handleSessionList(mainWindow);
      break;

    case 'session.start':
      await handleSessionStart(mainWindow, event.payload);
      break;

    case 'session.continue':
      await handleSessionContinue(mainWindow, event.payload);
      break;

    case 'session.editLatestPrompt':
      await handleEditLatestPrompt(mainWindow, event.payload);
      break;

    case 'session.history':
      handleSessionHistory(mainWindow, event.payload.sessionId);
      break;

    case 'session.stop':
      handleSessionStop(mainWindow, event.payload.sessionId);
      break;

    case 'runner.prewarm':
      // Fire-and-forget speculation; failures must never surface to the user.
      void handleRunnerPrewarm(mainWindow, event.payload).catch((error) => {
        if (isDev()) {
          console.warn('[Runner Prewarm] failed:', error);
        }
      });
      break;

    case 'session.delete':
      handleSessionDelete(mainWindow, event.payload.sessionId);
      break;

    case 'permission.response':
      handlePermissionResponse(event.payload);
      break;

    case 'mcp.get-config':
      handleMcpGetConfig(mainWindow, event.payload?.projectPath);
      break;

    case 'mcp.save-config':
      handleMcpSaveConfig(mainWindow, event.payload);
      break;

    case 'skills.list':
      handleSkillsList(mainWindow, event.payload?.projectPath);
      break;

    case 'session.togglePin':
      handleSessionTogglePin(mainWindow, event.payload);
      break;

    case 'folder.list':
      handleFolderList(mainWindow);
      break;

    case 'folder.create':
      handleFolderCreate(mainWindow, event.payload);
      break;

    case 'folder.update':
      handleFolderUpdate(mainWindow, event.payload);
      break;

    case 'folder.delete':
      handleFolderDelete(mainWindow, event.payload);
      break;

    case 'folder.move':
      handleFolderMove(mainWindow, event.payload);
      break;

    case 'session.setFolder':
      handleSessionSetFolder(mainWindow, event.payload);
      break;

    case 'session.setChannel':
      handleSessionSetChannel(mainWindow, event.payload);
      break;

    case 'session.setTeam':
      handleSessionSetTeam(mainWindow, event.payload);
      break;
  }
}

// Map a stored session row to the renderer-facing SessionInfo shape.
function buildSessionInfoFromRow(
  row: ReturnType<typeof sessions.listSessions>[number],
  latestClaudeModelUsage?: ReturnType<typeof sessions.getLatestClaudeModelUsageBySession>[string]
): SessionInfo {
  return {
    id: row.id,
    title: row.title,
    status: row.status as SessionInfo['status'],
    scope: normalizeSessionScope(row.conversation_scope),
    agentId: row.agent_id || null,
    source:
      row.session_origin === 'claude_remote'
        ? 'claude_remote'
        : row.provider === 'codex'
          ? 'codex_local'
          : row.provider === 'opencode'
            ? 'opencode_local'
            : row.provider === 'kimi'
              ? 'kimi_local'
              : row.provider === 'grok'
                ? 'grok_local'
                : row.provider === 'pi'
                  ? 'pi_local'
                : 'aegis',
    readOnly: row.session_origin === 'claude_remote',
    cwd: row.cwd || undefined,
    projectCwd: row.project_cwd || row.cwd || null,
    envMode: row.env_mode === 'worktree' ? 'worktree' : 'local',
    worktreePath: row.worktree_path || null,
    associatedWorktreePath: row.associated_worktree_path || null,
    associatedWorktreeBranch: row.associated_worktree_branch || null,
    associatedWorktreeRef: row.associated_worktree_ref || null,
    claudeSessionId: row.claude_session_id || undefined,
    provider: row.provider || 'claude',
    model: row.model || undefined,
    compatibleProviderId: row.compatible_provider_id || undefined,
    betas: parseStoredBetas(row.betas),
    claudeAccessMode: normalizeClaudeAccessMode(row.claude_access_mode),
    claudeExecutionMode: normalizeClaudeExecutionMode(row.claude_execution_mode, row.claude_access_mode),
    claudeReasoningEffort: normalizeClaudeReasoningEffort(row.claude_reasoning_effort),
    codexExecutionMode: normalizeCodexExecutionMode(row.codex_execution_mode),
    codexPermissionMode: normalizeCodexPermissionMode(row.codex_permission_mode),
    codexReasoningEffort: normalizeCodexReasoningEffort(row.codex_reasoning_effort),
    codexFastMode: normalizeCodexFastMode(row.codex_fast_mode),
    opencodePermissionMode: normalizeOpenCodePermissionMode(row.opencode_permission_mode),
    pinned: row.pinned === 1,
    folderPath: row.folder_path || null,
    hiddenFromThreads: row.hidden_from_threads === 1,
    channelId: normalizeWorkspaceChannelId(row.workspace_channel_id),
    teamMode: normalizeSessionTeamMode(row.team_mode),
    teamId: row.team_id || null,
    handoffSourceProvider: (row.handoff_source_provider as AgentProvider | null) || null,
    latestClaudeModelUsage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 会话列表
function handleSessionList(mainWindow: BrowserWindow): void {
  const rows = sessions.listSessions();
  const latestClaudeModelUsageBySession = sessions.getLatestClaudeModelUsageBySession();
  const sessionInfos: SessionInfo[] = rows.map((row) =>
    buildSessionInfoFromRow(row, latestClaudeModelUsageBySession[row.id])
  );

  broadcast(mainWindow, {
    type: 'session.list',
    payload: { sessions: sessionInfos },
  });

  // 同时发送文件夹列表
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 新建会话
async function handleSessionStart(
  mainWindow: BrowserWindow,
  payload: SessionStartPayload
): Promise<string | null> {
  const {
    title,
    prompt,
    effectivePrompt,
    automationRunId,
    skipTitleGeneration,
    cwd,
    projectCwd,
    envMode,
    worktreePath,
    associatedWorktreePath,
    associatedWorktreeBranch,
    associatedWorktreeRef,
    scope,
    agentId,
    allowedTools,
    attachments,
    provider,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    claudeReasoningEffort,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
    codexSkills,
    codexMentions,
    kimiPermissionMode,
    grokPermissionMode,
    grokReasoningEffort,
    opencodePermissionMode,
    teamMode,
    teamId,
    hiddenFromThreads,
    channelId,
    createIsolatedWorkspace,
  } = payload;
  const sessionScope = normalizeSessionScope(scope);
  const sessionAgentId = sessionScope === 'dm' ? agentId?.trim() || null : null;
  const sessionCwd = cwd?.trim() || undefined;
  if (sessionScope !== 'dm' && !sessionCwd) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Select a project folder before starting a task.' },
    });
    return null;
  }
  const chosenProvider = provider || 'claude';
  const normalizedProjectCwd = projectCwd?.trim() || sessionCwd || null;
  const normalizedEnvMode = envMode === 'worktree' ? 'worktree' : 'local';
  const normalizedWorktreePath = worktreePath?.trim() || null;

  // "在隔离副本中运行"：开跑前建好 worktree（session 的 cwd 会指向它），
  // 建不出来（非 git 仓库等）直接明确报错，不静默降级到项目本体。
  let isolated: IsolatedWorkspaceProvision | null = null;
  if (createIsolatedWorkspace && sessionCwd) {
    try {
      // 提示词本地能 slug 化就直接用，起跑不等 LLM；slug 化失败（如中文提示词）
      // 才让选定的 provider 用英文概括任务当分支名（超时/失败静默退回本地 slug/哈希）
      const promptHint = prompt.slice(0, 80);
      const llmSlug = branchSlugFromHint(promptHint)
        ? null
        : await generateWorktreeBranchSlug({
            prompt,
            cwd: sessionCwd,
            provider: chosenProvider,
            model: normalizeModel(model) || undefined,
            compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
            betas: chosenProvider === 'claude' ? normalizeBetas(betas) : undefined,
          });
      isolated = await provisionIsolatedWorkspace(sessionCwd, llmSlug || promptHint);
    } catch (error) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Could not create a worktree — this needs a git repository with at least one commit. ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
      return null;
    }
  }
  const sourcePrompt = prompt.trim();
  const longPromptAttachment = await maybeConvertLongPromptToAttachment({
    cwd: sessionCwd,
    prompt: sourcePrompt,
    attachments,
  });
  const outgoingPrompt = longPromptAttachment.prompt;
  const outgoingAttachments = longPromptAttachment.attachments;
  const effectiveRunnerPrompt = longPromptAttachment.converted
    ? outgoingPrompt
    : (effectivePrompt ?? sourcePrompt).trim();
  const runnerPrompt = augmentPromptForLiveWidgetProtocol(
    await buildRunnerPromptWithMemory(chosenProvider, effectiveRunnerPrompt, sessionCwd),
  );
  const selectedModel = normalizeModel(model);
  const selectedBetas = chosenProvider === 'claude' ? normalizeBetas(betas) : undefined;
  const selectedClaudeAccessMode =
    chosenProvider === 'claude' ? normalizeClaudeAccessMode(claudeAccessMode) : undefined;
  const selectedClaudeExecutionMode =
    chosenProvider === 'claude'
      ? normalizeClaudeExecutionMode(claudeExecutionMode, selectedClaudeAccessMode)
      : undefined;
  const selectedClaudeReasoningEffort =
    chosenProvider === 'claude' ? normalizeClaudeReasoningEffort(claudeReasoningEffort) : undefined;
  const selectedKimiPermissionMode =
    chosenProvider === 'kimi' ? normalizeKimiPermissionMode(kimiPermissionMode) : undefined;
  // Composer currently reuses the kimi permission control for Grok; accept either field.
  const selectedGrokPermissionMode =
    chosenProvider === 'grok'
      ? normalizeGrokPermissionMode(grokPermissionMode || kimiPermissionMode)
      : undefined;
  const selectedGrokReasoningEffort =
    chosenProvider === 'grok' ? normalizeGrokReasoningEffort(grokReasoningEffort) : undefined;
  const normalizedTeamMode = normalizeSessionTeamMode(teamMode);
  const normalizedTeamId =
    normalizedTeamMode === 'team' || normalizedTeamMode === 'manual'
      ? teamId?.trim() || null
      : null;

  // 运行时状态检查已移动到会话创建和状态广播之后，以便前端立即显示 spinning 效果

  if (isDev()) {
    console.log('[Session Start]', {
      provider: chosenProvider,
      model: selectedModel,
      compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
      scope: sessionScope,
      agentId: sessionAgentId || undefined,
      cwd: sessionCwd,
    });
  }

  // 创建会话（用临时标题）
  const session = sessions.createSession({
    title,
    cwd: sessionCwd,
    projectCwd: isolated ? isolated.repoRoot : normalizedProjectCwd,
    envMode: isolated ? 'worktree' : normalizedEnvMode,
    worktreePath: isolated ? isolated.worktreePath : normalizedWorktreePath,
    associatedWorktreePath: isolated
      ? isolated.worktreePath
      : associatedWorktreePath?.trim() || normalizedWorktreePath,
    associatedWorktreeBranch: isolated ? isolated.branch : associatedWorktreeBranch?.trim() || null,
    associatedWorktreeRef: isolated
      ? isolated.baseRef
      : associatedWorktreeRef?.trim() || associatedWorktreeBranch?.trim() || null,
    scope: sessionScope,
    agentId: sessionAgentId,
    allowedTools,
    prompt: outgoingPrompt,
    provider: chosenProvider,
    model: selectedModel,
    compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
    betas: selectedBetas,
    claudeAccessMode: selectedClaudeAccessMode,
    claudeExecutionMode: selectedClaudeExecutionMode,
    claudeReasoningEffort: selectedClaudeReasoningEffort,
    codexExecutionMode:
      chosenProvider === 'codex' ? normalizeCodexExecutionMode(codexExecutionMode) : undefined,
    codexPermissionMode: chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
    codexReasoningEffort:
      chosenProvider === 'codex' ? normalizeCodexReasoningEffort(codexReasoningEffort) : undefined,
    codexFastMode: chosenProvider === 'codex' ? normalizeCodexFastMode(codexFastMode) : undefined,
    opencodePermissionMode:
      chosenProvider === 'opencode' ? normalizeOpenCodePermissionMode(opencodePermissionMode) : undefined,
    hiddenFromThreads: hiddenFromThreads === true,
    channelId: normalizeWorkspaceChannelId(channelId),
    teamMode: normalizedTeamMode,
    teamId: normalizedTeamId,
  });

  // 更新状态为 running
  sessions.updateSessionStatus(session.id, 'running');
  if (automationRunId) {
    sessions.setAutomationRunSession(automationRunId, session.id);
    broadcastAutomationChanged(mainWindow);
  }

  // 立即广播状态 -> 界面跳转
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId: session.id,
      status: 'running',
      title: session.title,
      scope: normalizeSessionScope(session.conversation_scope),
      agentId: session.agent_id || null,
      cwd: session.cwd || undefined,
      projectCwd: session.project_cwd || session.cwd || null,
      envMode: session.env_mode === 'worktree' ? 'worktree' : 'local',
      worktreePath: session.worktree_path || null,
      associatedWorktreePath: session.associated_worktree_path || null,
      associatedWorktreeBranch: session.associated_worktree_branch || null,
      associatedWorktreeRef: session.associated_worktree_ref || null,
      provider: chosenProvider,
      model: selectedModel,
      compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
      betas: selectedBetas,
      claudeAccessMode: selectedClaudeAccessMode,
      claudeExecutionMode: selectedClaudeExecutionMode,
      claudeReasoningEffort: selectedClaudeReasoningEffort,
      codexExecutionMode:
        chosenProvider === 'codex' ? normalizeCodexExecutionMode(codexExecutionMode) : undefined,
      codexPermissionMode: chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
      codexReasoningEffort:
        chosenProvider === 'codex' ? normalizeCodexReasoningEffort(codexReasoningEffort) : undefined,
      codexFastMode: chosenProvider === 'codex' ? normalizeCodexFastMode(codexFastMode) : undefined,
      kimiPermissionMode: selectedKimiPermissionMode,
      opencodePermissionMode:
        chosenProvider === 'opencode' ? normalizeOpenCodePermissionMode(opencodePermissionMode) : undefined,
      hiddenFromThreads: session.hidden_from_threads === 1,
      channelId: normalizeWorkspaceChannelId(session.workspace_channel_id),
      teamMode: normalizeSessionTeamMode(session.team_mode),
      teamId: session.team_id || null,
    },
  });

  // 广播用户 prompt（在运行时检查之前，让用户消息立即显示）
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt: outgoingPrompt, attachments: outgoingAttachments, createdAt },
  });

  // 保存 user_prompt
  sessions.addMessage(session.id, {
    type: 'user_prompt',
    prompt: outgoingPrompt,
    attachments: outgoingAttachments,
    createdAt,
  });

  // 检查运行时状态（在会话状态已设为 running 之后，以便前端立即显示 spinning 效果）
  if (chosenProvider === 'claude') {
    const runtimeStatus = await getClaudeRuntimeStatusCached(selectedModel || null);
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(session.id, 'error');
      if (automationRunId) {
        sessions.finishAutomationRun(automationRunId, 'failed', formatClaudeRuntimeBlockingMessage(runtimeStatus));
        broadcastAutomationChanged(mainWindow);
      }
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatClaudeRuntimeBlockingMessage(runtimeStatus),
        },
      });
      return null;
    }
  } else if (chosenProvider === 'opencode') {
    const runtimeStatus = await getOpencodeRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(session.id, 'error');
      if (automationRunId) {
        sessions.finishAutomationRun(automationRunId, 'failed', 'OpenCode SDK is not ready. Check Settings > Providers.');
        broadcastAutomationChanged(mainWindow);
      }
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: 'OpenCode SDK is not ready. Check Settings > Providers.',
        },
      });
      return null;
    }
  } else if (chosenProvider === 'kimi') {
    const runtimeStatus = await getKimiRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(session.id, 'error');
      if (automationRunId) {
        sessions.finishAutomationRun(automationRunId, 'failed', formatKimiRuntimeBlockingMessage(runtimeStatus));
        broadcastAutomationChanged(mainWindow);
      }
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatKimiRuntimeBlockingMessage(runtimeStatus),
        },
      });
      return null;
    }
  } else if (chosenProvider === 'grok') {
    const runtimeStatus = await getGrokRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(session.id, 'error');
      if (automationRunId) {
        sessions.finishAutomationRun(automationRunId, 'failed', formatGrokRuntimeBlockingMessage(runtimeStatus));
        broadcastAutomationChanged(mainWindow);
      }
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatGrokRuntimeBlockingMessage(runtimeStatus),
        },
      });
      return null;
    }
  }

  // 异步生成更好的标题（不阻塞）
  if (sessionScope !== 'dm' && !skipTitleGeneration) {
    generateSessionTitle(
      sourcePrompt,
      sessionCwd,
      chosenProvider === 'claude' ? selectedModel : undefined,
      chosenProvider === 'claude' ? compatibleProviderId : undefined,
      chosenProvider === 'claude' ? selectedBetas : undefined,
      chosenProvider,
      selectedClaudeReasoningEffort
    ).then((newTitle) => {
      const trimmedTitle = newTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      sessions.updateSessionTitle(session.id, trimmedTitle);
      const latest = sessions.getSession(session.id);
      const currentStatus = latest?.status || session.status || 'running';
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: currentStatus as SessionStatus,
          title: trimmedTitle,
          scope: normalizeSessionScope(latest?.conversation_scope),
          agentId: latest?.agent_id || null,
          hiddenFromThreads: latest?.hidden_from_threads === 1,
        },
      });
    }).catch((err) => {
      console.error('Failed to generate title:', err);
    });
  }

  // 启动 Runner
  startRunner(
    mainWindow,
    session,
    runnerPrompt,
    undefined,
    outgoingAttachments,
    chosenProvider,
    selectedModel,
    chosenProvider === 'claude' ? compatibleProviderId : undefined,
    selectedBetas,
    selectedClaudeAccessMode,
    selectedClaudeExecutionMode,
    selectedClaudeReasoningEffort,
    chosenProvider === 'codex' ? normalizeCodexExecutionMode(codexExecutionMode) : undefined,
    chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
    chosenProvider === 'codex' ? normalizeCodexReasoningEffort(codexReasoningEffort) : undefined,
    chosenProvider === 'codex' ? normalizeCodexFastMode(codexFastMode) : undefined,
    chosenProvider === 'opencode' ? normalizeOpenCodePermissionMode(opencodePermissionMode) : undefined,
    selectedKimiPermissionMode,
    selectedGrokPermissionMode,
    selectedGrokReasoningEffort,
    chosenProvider === 'codex' ? codexSkills : undefined,
    chosenProvider === 'codex' ? codexMentions : undefined,
    sessionAgentId,
    automationRunId
      ? (status, failureMessage) => {
          const runStatus = status === 'completed' ? 'completed' : 'failed';
          const message =
            status === 'completed' ? null : failureMessage || `Automation session ended with ${status}.`;
          sessions.finishAutomationRun(automationRunId, runStatus, message);
          broadcastAutomationChanged(mainWindow);
        }
      : undefined,
    undefined,
    Boolean(automationRunId)
  );
  return session.id;
}

// 继续会话
async function handleSessionContinue(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<boolean> {
  const {
    sessionId,
    prompt,
    effectivePrompt,
    attachments,
    provider,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    claudeReasoningEffort,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
    codexSkills,
    codexMentions,
    kimiPermissionMode,
    grokPermissionMode,
    grokReasoningEffort,
    opencodePermissionMode,
    teamMode,
    teamId,
  } = payload;

  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return false;
  }

  const longPromptAttachment = await maybeConvertLongPromptToAttachment({
    cwd: session.cwd,
    prompt,
    attachments,
  });
  const outgoingPrompt = longPromptAttachment.prompt;
  const outgoingAttachments = longPromptAttachment.attachments;
  let effectiveRunnerPrompt = longPromptAttachment.converted
    ? outgoingPrompt
    : (effectivePrompt ?? outgoingPrompt).trim();

  if (await maybeHandleLocalSlashCommand(mainWindow, session, outgoingPrompt, outgoingAttachments)) {
    return true;
  }

  const sanitizedHistoryResult =
    session.provider === 'claude'
      ? sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId))
      : { messages: sessions.getSessionHistory(sessionId), hadInvalidThinking: false };
  const historyBeforeContinue = sanitizedHistoryResult.messages;

  // Codex two-phase stop hold (P0-6): a send landing inside the stopping
  // window waits for the stop to settle (≤10s + safety margin), then runs as
  // a fresh turn/start — never a steer into the turn being killed. The
  // runner entry is snapshotted AFTER the hold: settle retires the stopped
  // entry, so the flow below naturally falls into the fresh-spawn path (the
  // handle-identity re-check downstream stays as backstop).
  {
    const stoppingEntry = stoppingCodexSessions.get(sessionId);
    if (stoppingEntry && (provider || session.provider) === 'codex') {
      await stoppingEntry.settlePromise.catch(() => undefined);
    }
  }

  const existingEntry = runnerHandles.get(sessionId);
  const previousProvider = session.provider || 'claude';
  const nextProvider = provider || previousProvider;
  const sessionAgentId = session.agent_id || null;
  const nextModel = normalizeModel(model ?? session.model ?? undefined);
  const previousCompatibleProviderId = session.compatible_provider_id || undefined;
  const nextCompatibleProviderId =
    nextProvider === 'claude'
      ? compatibleProviderId ?? previousCompatibleProviderId
      : undefined;
  const previousBetas = parseStoredBetas(session.betas);
  const nextBetas = nextProvider === 'claude'
    ? normalizeBetas(betas ?? previousBetas)
    : undefined;
  const previousModel = normalizeModel(session.model ?? undefined);
  const providerChanged = nextProvider !== previousProvider;
  const compatibleProviderChanged = nextCompatibleProviderId !== previousCompatibleProviderId;
  // Claude compares alias-aware: init records the concrete model id the CLI
  // resolved a family alias to, while the composer keeps sending the alias —
  // a raw string comparison read that as a model change on EVERY follow-up,
  // aborting the warm runner (cold respawn + an "Operation aborted" error
  // toast from the torn-down stream) each message.
  const modelChanged =
    nextProvider === 'claude'
      ? !isSameClaudeModelSelection(nextModel, previousModel)
      : nextModel !== previousModel;
  const betasChanged = JSON.stringify(nextBetas || []) !== JSON.stringify(previousBetas || []);
  const previousClaudeAccessMode = normalizeClaudeAccessMode(session.claude_access_mode);
  const nextClaudeAccessMode =
    nextProvider === 'claude'
      ? normalizeClaudeAccessMode(claudeAccessMode || previousClaudeAccessMode)
      : undefined;
  const previousClaudeExecutionMode = normalizeClaudeExecutionMode(
    session.claude_execution_mode,
    previousClaudeAccessMode
  );
  const nextClaudeExecutionMode =
    nextProvider === 'claude'
      ? normalizeClaudeExecutionMode(claudeExecutionMode || previousClaudeExecutionMode, nextClaudeAccessMode)
      : undefined;
  const previousClaudeReasoningEffort = normalizeClaudeReasoningEffort(session.claude_reasoning_effort);
  const nextClaudeReasoningEffort =
    nextProvider === 'claude'
      ? normalizeClaudeReasoningEffort(claudeReasoningEffort || previousClaudeReasoningEffort)
      : undefined;
  const previousCodexPermissionMode = normalizeCodexPermissionMode(session.codex_permission_mode);
  const previousCodexExecutionMode = normalizeCodexExecutionMode(session.codex_execution_mode);
  const nextCodexExecutionMode = nextProvider === 'codex'
    ? normalizeCodexExecutionMode(codexExecutionMode || previousCodexExecutionMode)
    : undefined;
  const nextCodexPermissionMode = nextProvider === 'codex'
    ? normalizeCodexPermissionMode(codexPermissionMode || previousCodexPermissionMode)
    : undefined;
  const previousCodexReasoningEffort = normalizeCodexReasoningEffort(session.codex_reasoning_effort);
  const nextCodexReasoningEffort = nextProvider === 'codex'
    ? normalizeCodexReasoningEffort(codexReasoningEffort || previousCodexReasoningEffort)
    : undefined;
  const previousCodexFastMode = normalizeCodexFastMode(session.codex_fast_mode);
  const nextCodexFastMode = nextProvider === 'codex'
    ? normalizeCodexFastMode(codexFastMode ?? previousCodexFastMode)
    : undefined;
  const planImplementationPrompt =
    nextProvider === 'codex' && nextCodexExecutionMode === 'execute'
      ? maybeBuildPlanImplementationPrompt(effectiveRunnerPrompt, findLatestProposedPlan(historyBeforeContinue))
      : null;
  if (planImplementationPrompt) {
    effectiveRunnerPrompt = planImplementationPrompt;
  }
  // First prompt of a provider-handoff session: inject the imported transcript
  // so the new agent starts with the prior conversation's context.
  const handoffContextText =
    session.handoff_pending === 1
      ? buildHandoffContextText({
          history: historyBeforeContinue,
          title: session.title,
          sourceProvider: session.handoff_source_provider || previousProvider,
        })
      : null;
  if (handoffContextText) {
    effectiveRunnerPrompt = `<handoff_context>\n${handoffContextText}\n</handoff_context>\n\n<latest_user_message>\n${effectiveRunnerPrompt}\n</latest_user_message>`;
  }
  if (session.handoff_pending === 1) {
    sessions.clearSessionHandoffPending(sessionId);
  }
  const runnerPrompt = augmentPromptForLiveWidgetProtocol(
    await buildRunnerPromptWithMemory(nextProvider, effectiveRunnerPrompt, session.cwd || undefined),
    historyBeforeContinue
  );
  const previousOpenCodePermissionMode = normalizeOpenCodePermissionMode(session.opencode_permission_mode);
  const nextOpenCodePermissionMode = nextProvider === 'opencode'
    ? normalizeOpenCodePermissionMode(opencodePermissionMode || previousOpenCodePermissionMode)
    : undefined;
  const nextKimiPermissionMode = nextProvider === 'kimi'
    ? normalizeKimiPermissionMode(kimiPermissionMode)
    : undefined;
  const nextGrokPermissionMode = nextProvider === 'grok'
    ? normalizeGrokPermissionMode(grokPermissionMode || kimiPermissionMode)
    : undefined;
  const nextGrokReasoningEffort = nextProvider === 'grok'
    ? normalizeGrokReasoningEffort(grokReasoningEffort)
    : undefined;
  const nextTeamMode = teamMode !== undefined
    ? normalizeSessionTeamMode(teamMode)
    : normalizeSessionTeamMode(session.team_mode);
  const nextTeamId =
    nextTeamMode === 'team' || nextTeamMode === 'manual'
      ? teamId?.trim() || session.team_id || null
      : null;
  const accessModeChanged =
    nextProvider === 'claude' &&
    normalizeClaudeAccessMode(runnerHandles.get(sessionId)?.claudeAccessMode || previousClaudeAccessMode) !==
      nextClaudeAccessMode;
  const executionModeChanged =
    nextProvider === 'claude' &&
    normalizeClaudeExecutionMode(
      runnerHandles.get(sessionId)?.claudeExecutionMode || previousClaudeExecutionMode,
      runnerHandles.get(sessionId)?.claudeAccessMode || previousClaudeAccessMode
    ) !== nextClaudeExecutionMode;
  const claudeReasoningEffortChanged =
    nextProvider === 'claude' &&
    normalizeClaudeReasoningEffort(
      runnerHandles.get(sessionId)?.claudeReasoningEffort || previousClaudeReasoningEffort
    ) !== nextClaudeReasoningEffort;
  const codexPermissionModeChanged =
    nextProvider === 'codex' &&
    normalizeCodexPermissionMode(runnerHandles.get(sessionId)?.codexPermissionMode || previousCodexPermissionMode) !== nextCodexPermissionMode;
  const codexExecutionModeChanged =
    nextProvider === 'codex' &&
    normalizeCodexExecutionMode(runnerHandles.get(sessionId)?.codexExecutionMode || previousCodexExecutionMode) !== nextCodexExecutionMode;
  const codexReasoningEffortChanged =
    nextProvider === 'codex' &&
    normalizeCodexReasoningEffort(
      runnerHandles.get(sessionId)?.codexReasoningEffort || previousCodexReasoningEffort
    ) !== nextCodexReasoningEffort;
  const codexFastModeChanged =
    nextProvider === 'codex' &&
    normalizeCodexFastMode(runnerHandles.get(sessionId)?.codexFastMode ?? previousCodexFastMode) !==
      nextCodexFastMode;
  const grokReasoningEffortChanged =
    nextProvider === 'grok' &&
    normalizeGrokReasoningEffort(runnerHandles.get(sessionId)?.grokReasoningEffort) !==
      nextGrokReasoningEffort;
  const opencodePermissionModeChanged =
    nextProvider === 'opencode' &&
    normalizeOpenCodePermissionMode(
      runnerHandles.get(sessionId)?.opencodePermissionMode || previousOpenCodePermissionMode
    ) !== nextOpenCodePermissionMode;
  // Every live runner is bound to the cwd it spawned with. If the session's
  // workspace moved since (handoff, worktree move, external mutation), the
  // handle must never be reused — for any provider — or the next turn would
  // execute against the old checkout.
  const runnerCwdChanged =
    existingEntry !== undefined && (existingEntry.cwd ?? null) !== effectiveRunnerCwd(session);
  // 运行时状态检查已移动到会话状态广播之后，以便前端立即显示 spinning 效果

  if (isDev()) {
    console.log('[Session Continue]', {
      sessionId,
      payloadProvider: provider,
      previousProvider,
      nextProvider,
      nextModel,
      previousModel,
      nextCompatibleProviderId,
      nextBetas,
      providerChanged,
      compatibleProviderChanged,
      modelChanged,
      betasChanged,
      accessModeChanged,
      executionModeChanged,
      claudeReasoningEffortChanged,
      runnerCwdChanged,
      entryDoomed: existingEntry?.doomed === true,
      entryAutoApprove: existingEntry?.autoApprove === true,
      codexExecutionModeChanged,
      codexPermissionModeChanged,
      codexReasoningEffortChanged,
      codexFastModeChanged,
      kimiPermissionMode: nextKimiPermissionMode,
      opencodePermissionModeChanged,
      hasExistingRunner: !!existingEntry,
    });
  }

  if (providerChanged) {
    sessions.updateSessionProvider(sessionId, nextProvider);
  }
  sessions.updateSessionModel(sessionId, nextModel || null);
  sessions.updateSessionCompatibleProviderId(
    sessionId,
    nextProvider === 'claude' ? nextCompatibleProviderId || null : null
  );
  sessions.updateSessionBetas(sessionId, nextBetas || null);
  if (nextProvider === 'claude') {
    sessions.updateSessionClaudeAccessMode(sessionId, nextClaudeAccessMode || 'default');
    sessions.updateSessionClaudeExecutionMode(sessionId, nextClaudeExecutionMode || 'execute');
    sessions.updateSessionClaudeReasoningEffort(sessionId, nextClaudeReasoningEffort || 'high');
  }
  if (nextProvider === 'codex') {
    sessions.updateSessionCodexExecutionMode(sessionId, nextCodexExecutionMode || 'execute');
    sessions.updateSessionCodexPermissionMode(sessionId, nextCodexPermissionMode || 'defaultPermissions');
    sessions.updateSessionCodexReasoningEffort(sessionId, nextCodexReasoningEffort || null);
    sessions.updateSessionCodexFastMode(sessionId, nextCodexFastMode === true);
  }
  if (nextProvider === 'opencode') {
    sessions.updateSessionOpenCodePermissionMode(
      sessionId,
      nextOpenCodePermissionMode || 'defaultPermissions'
    );
  }
  if (teamMode !== undefined || teamId !== undefined) {
    sessions.updateSessionTeam(sessionId, nextTeamMode, nextTeamId);
  }

  // 更新状态
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, outgoingPrompt);

  // 广播状态
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      scope: normalizeSessionScope(session.conversation_scope),
      agentId: session.agent_id || null,
      cwd: session.cwd || undefined,
      projectCwd: session.project_cwd || session.cwd || null,
      envMode: session.env_mode === 'worktree' ? 'worktree' : 'local',
      worktreePath: session.worktree_path || null,
      associatedWorktreePath: session.associated_worktree_path || null,
      associatedWorktreeBranch: session.associated_worktree_branch || null,
      associatedWorktreeRef: session.associated_worktree_ref || null,
      provider: nextProvider,
      model: nextModel ?? '',
      compatibleProviderId: nextProvider === 'claude' ? nextCompatibleProviderId : undefined,
      betas: nextBetas,
      claudeAccessMode: nextProvider === 'claude' ? nextClaudeAccessMode : undefined,
      claudeExecutionMode: nextProvider === 'claude' ? nextClaudeExecutionMode : undefined,
      claudeReasoningEffort: nextProvider === 'claude' ? nextClaudeReasoningEffort : undefined,
      codexExecutionMode: nextProvider === 'codex' ? (nextCodexExecutionMode || 'execute') : undefined,
      codexPermissionMode: nextProvider === 'codex' ? (nextCodexPermissionMode || 'defaultPermissions') : undefined,
      codexReasoningEffort: nextProvider === 'codex' ? nextCodexReasoningEffort : undefined,
      codexFastMode: nextProvider === 'codex' ? nextCodexFastMode : undefined,
      kimiPermissionMode: nextKimiPermissionMode,
      opencodePermissionMode:
        nextProvider === 'opencode' ? (nextOpenCodePermissionMode || 'defaultPermissions') : undefined,
      hiddenFromThreads: session.hidden_from_threads === 1,
      teamMode: nextTeamMode,
      teamId: nextTeamId,
    },
  });

  // 广播用户 prompt（在运行时检查之前，让用户消息立即显示）
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId, prompt: outgoingPrompt, attachments: outgoingAttachments, createdAt },
  });

  // 保存 user_prompt
  sessions.addMessage(sessionId, {
    type: 'user_prompt',
    prompt: outgoingPrompt,
    attachments: outgoingAttachments,
    createdAt,
  });

  // 检查运行时状态（在会话状态已设为 running 之后，以便前端立即显示 spinning 效果）
  if (nextProvider === 'claude') {
    const runtimeStatus = await getClaudeRuntimeStatusCached(nextModel || null);
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatClaudeRuntimeBlockingMessage(runtimeStatus),
          sessionId,
        },
      });
      return false;
    }
  } else if (nextProvider === 'opencode') {
    const runtimeStatus = await getOpencodeRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: 'OpenCode SDK is not ready. Check Settings > Providers.',
          sessionId,
        },
      });
      return false;
    }
  } else if (nextProvider === 'kimi') {
    const runtimeStatus = await getKimiRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatKimiRuntimeBlockingMessage(runtimeStatus),
          sessionId,
        },
      });
      return false;
    }
  } else if (nextProvider === 'grok') {
    const runtimeStatus = await getGrokRuntimeStatus();
    if (!runtimeStatus.ready) {
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatGrokRuntimeBlockingMessage(runtimeStatus),
          sessionId,
        },
      });
      return false;
    }
  }

  // While a codex turn is still streaming, a follow-up send becomes a
  // turn/steer injection into that turn. Composer config drift (model /
  // effort / permission mode) must NOT abort the live runner then — that
  // would kill the running turn instead of steering it. The manager records
  // the new values on the session, so they apply from the next turn/start.
  const codexMidTurn = nextProvider === 'codex' && session.status === 'running';

  if (existingEntry && !providerChanged && existingEntry.provider === nextProvider) {
    if (
      runnerCwdChanged ||
      (((nextProvider === 'codex' && !codexMidTurn) || nextProvider === 'opencode' || nextProvider === 'kimi' || nextProvider === 'grok' || nextProvider === 'pi') && modelChanged) ||
      (nextProvider === 'codex' && !codexMidTurn && codexPermissionModeChanged) ||
      (nextProvider === 'codex' && !codexMidTurn && codexReasoningEffortChanged) ||
      (nextProvider === 'codex' && !codexMidTurn && codexFastModeChanged) ||
      (nextProvider === 'grok' && grokReasoningEffortChanged) ||
      (nextProvider === 'opencode' && opencodePermissionModeChanged) ||
      (nextProvider === 'claude' &&
        (
          modelChanged ||
          compatibleProviderChanged ||
          betasChanged ||
          accessModeChanged ||
          executionModeChanged ||
          claudeReasoningEffortChanged ||
          // Never reuse a runner whose live context is stale/poisoned, an
          // auto-approving automation runner for a human turn, or a live
          // context that still contains invalid thinking blocks the stored
          // history was sanitized against.
          existingEntry.doomed === true ||
          existingEntry.autoApprove === true ||
          sanitizedHistoryResult.hadInvalidThinking
        ))
    ) {
      clearStopFallbackTimer(existingEntry);
      existingEntry.handle.abort();
      runnerHandles.delete(sessionId);
    } else if (runnerHandles.get(sessionId)?.handle !== existingEntry.handle) {
      // A reaper tick or config flush retired the entry while the awaits
      // above ran — fall through to a fresh spawn.
    } else {
      existingEntry.activeAgentId = sessionAgentId;
      existingEntry.activeAgentRunId = createAgentRunId(sessionAgentId, 'continue');
      if (nextProvider === 'claude') {
        // Only a dispatch into an IDLE runner opens a latency window. A turn
        // queued while a previous one is still streaming can't be timed with
        // a session-keyed window — the earlier turn's ongoing deltas would
        // satisfy its first-output instantly. The metric targets the
        // idle→busy startup latency (cold / warm-reuse / prewarm-hit), which
        // is exactly the idle-dispatch case.
        const wasIdle = (existingEntry.inFlightTurns ?? 0) === 0;
        // Count the dispatched turn BEFORE send so the reaper can never see
        // this entry as idle between dispatch and the first stream message.
        existingEntry.inFlightTurns = (existingEntry.inFlightTurns ?? 0) + 1;
        (existingEntry.pendingTurnPrompts ??= []).push(runnerPrompt);
        if (wasIdle) {
          markClaudePromptDispatched(
            sessionId,
            existingEntry.prewarmed ? 'prewarm-hit' : 'warm-reuse',
            false
          );
        }
        existingEntry.prewarmed = false;
      }
      const sendOptions =
        nextProvider === 'codex'
	          ? {
	              codexExecutionMode: nextCodexExecutionMode,
	              codexPermissionMode: nextCodexPermissionMode,
	              codexReasoningEffort: nextCodexReasoningEffort || undefined,
	              codexFastMode: nextCodexFastMode,
	            }
	          : nextProvider === 'kimi'
	          ? {
	              kimiPermissionMode: nextKimiPermissionMode,
	            }
          : undefined;
      existingEntry.handle.send(
        runnerPrompt,
        outgoingAttachments,
        nextModel,
        nextProvider === 'codex' ? codexSkills : undefined,
        nextProvider === 'codex' ? codexMentions : undefined,
        sendOptions
      );
	      if (nextProvider === 'codex') {
	        existingEntry.codexExecutionMode = nextCodexExecutionMode;
	        existingEntry.codexPermissionMode = nextCodexPermissionMode;
	        existingEntry.codexReasoningEffort = nextCodexReasoningEffort || undefined;
	        existingEntry.codexFastMode = nextCodexFastMode;
	      }
	      if (nextProvider === 'kimi') {
	        existingEntry.kimiPermissionMode = nextKimiPermissionMode;
	      }
      return true;
    }
  }

  if (existingEntry && providerChanged) {
    clearStopFallbackTimer(existingEntry);
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  let startModel = nextModel;

  // 启动 Runner（带 resume）
  const resumeSessionId =
    providerChanged
      ? undefined
      : nextProvider === 'claude'
        ? sessions.getSession(sessionId)?.claude_session_id ?? undefined
        : nextProvider === 'codex'
          ? session.codex_session_id ?? undefined
          : nextProvider === 'opencode'
            ? session.opencode_session_id ?? undefined
            : nextProvider === 'kimi'
              ? session.kimi_session_id ?? undefined
              : nextProvider === 'grok'
                ? session.grok_session_id ?? undefined
                : nextProvider === 'pi'
                  ? session.pi_session_id ?? undefined
                  : undefined;
  let nextResumeSessionId = resumeSessionId;

  if (
    nextProvider === 'claude' &&
    !providerChanged &&
    !nextResumeSessionId &&
    // A pending handoff carries the transcript inside the prompt itself; the
    // copied history must not also be replayed into a bootstrap session.
    !handoffContextText &&
    historyBeforeContinue.length > 0
  ) {
    try {
      const bootstrap = await bootstrapClaudeSessionFromHistory({
        history: historyBeforeContinue,
        cwd: session.cwd,
        model: nextModel,
        compatibleProviderId: nextCompatibleProviderId,
        betas: nextBetas,
        claudeReasoningEffort: nextClaudeReasoningEffort,
      });
      nextResumeSessionId = bootstrap.sessionId;
      startModel = normalizeModel(bootstrap.model || nextModel || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId,
          status: 'error',
          provider: nextProvider,
          hiddenFromThreads: session.hidden_from_threads === 1,
        },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Failed to rebuild Claude conversation context: ${message}`,
          sessionId,
        },
      });
      return false;
    }
  }

  startRunner(
    mainWindow,
    sessions.getSession(sessionId),
    runnerPrompt,
    nextResumeSessionId,
    outgoingAttachments,
    nextProvider,
    startModel,
    nextProvider === 'claude' ? nextCompatibleProviderId : undefined,
    nextBetas,
    nextClaudeAccessMode,
    nextClaudeExecutionMode,
    nextProvider === 'claude' ? nextClaudeReasoningEffort : undefined,
    nextProvider === 'codex' ? (nextCodexExecutionMode || 'execute') : undefined,
    nextProvider === 'codex' ? (nextCodexPermissionMode || 'defaultPermissions') : undefined,
    nextProvider === 'codex' ? nextCodexReasoningEffort : undefined,
    nextProvider === 'codex' ? nextCodexFastMode : undefined,
    nextProvider === 'opencode' ? (nextOpenCodePermissionMode || 'defaultPermissions') : undefined,
    nextProvider === 'kimi' ? nextKimiPermissionMode : undefined,
    nextProvider === 'grok' ? nextGrokPermissionMode : undefined,
    nextProvider === 'grok' ? nextGrokReasoningEffort : undefined,
    nextProvider === 'codex' ? codexSkills : undefined,
    nextProvider === 'codex' ? codexMentions : undefined,
    sessionAgentId
  );
  return true;
}

// 启动 Runner
function startRunner(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  resumeSessionId?: string,
  attachments?: Attachment[],
  providerOverride?: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi',
  modelOverride?: string,
  compatibleProviderOverride?: import('../shared/types').ClaudeCompatibleProviderId,
  betasOverride?: string[],
  claudeAccessMode?: import('../shared/types').ClaudeAccessMode,
  claudeExecutionMode?: import('../shared/types').ClaudeExecutionMode,
  claudeReasoningEffort?: import('../shared/types').ClaudeReasoningEffort,
  codexExecutionMode?: import('../shared/types').CodexExecutionMode,
  codexPermissionMode?: import('../shared/types').CodexPermissionMode,
  codexReasoningEffort?: import('../shared/types').CodexReasoningEffort,
  codexFastMode?: boolean,
  opencodePermissionMode?: import('../shared/types').OpenCodePermissionMode,
  kimiPermissionMode?: import('../shared/types').KimiPermissionMode,
  grokPermissionMode?: import('../shared/types').GrokPermissionMode,
  grokReasoningEffort?: import('../shared/types').GrokReasoningEffort,
  codexSkills?: ProviderInputReference[],
  codexMentions?: ProviderInputReference[],
  activeAgentId?: string | null,
  onTurnDone?: (status: SessionStatus, message?: string) => void,
  activeAgentRunId?: string | null,
  autoApprovePermissions = false,
  // P3: spawn speculatively with an EMPTY prompt. runClaude's enqueuePrompt
  // drops empty prompts before they reach the input queue, but the SDK's
  // query() spawns the CLI and completes its initialize handshake (settings,
  // slash-command scan, MCP connections) eagerly — so the expensive boot
  // happens while the user is still typing. (The SDK's startup()/WarmQuery
  // primitive was evaluated for this: it pre-warms the same way but requires
  // splitting runClaude into a warm phase and a query phase, with canUseTool
  // and the full option set bound at warm time — the empty-prompt path gets
  // identical behavior through the existing runner plumbing.)
  prewarmRunner = false
): void {
  if (!session) return;

  const runnerSession =
    session.conversation_scope === 'dm' && !session.cwd
      ? { ...session, cwd: getDirectMessageRuntimeCwd() }
      : session;
  const sessionState = getSessionState(session.id);
  const provider = providerOverride || session.provider || 'claude';
  if (provider === 'claude' && prompt.trim().length > 0) {
    markClaudePromptDispatched(session.id, 'cold-start', Boolean(resumeSessionId));
  }
  const normalizedActiveAgentId = activeAgentId?.trim() || session.agent_id || null;
  const normalizedActiveAgentRunId =
    activeAgentRunId?.trim() || createAgentRunId(normalizedActiveAgentId, 'direct');
  const compatibleProviderId =
    provider === 'claude'
      ? compatibleProviderOverride || session.compatible_provider_id || undefined
      : undefined;
  const normalizedClaudeAccessMode =
    provider === 'claude'
      ? normalizeClaudeAccessMode(claudeAccessMode || session.claude_access_mode)
      : undefined;
  const normalizedClaudeExecutionMode =
    provider === 'claude'
      ? normalizeClaudeExecutionMode(
          claudeExecutionMode || session.claude_execution_mode,
          normalizedClaudeAccessMode
        )
      : undefined;

  if (isDev()) {
    console.log('[Runner Select]', {
      sessionId: session.id,
      provider,
      runner:
        provider === 'claude'
          ? 'claude-agent-sdk'
          : provider === 'codex'
          ? 'codex-app-server'
          : provider === 'kimi'
            ? 'kimi acp'
            : 'opencode sdk',
      model: modelOverride,
      compatibleProviderId,
      cwd: runnerSession.cwd || process.cwd(),
      scope: normalizeSessionScope(session.conversation_scope),
      hasResume: !!resumeSessionId,
    });
  }

  let initMessage: Extract<StreamMessage, { type: 'system'; subtype: 'init' }> | null = null;
  let sawTurnOutput = false;
  let localFailureMessage: string | null = null;

  // Never orphan a previous runner: overwriting the map entry would leave its
  // CLI process alive with no owner able to abort it. Abort BEFORE creating
  // the replacement — provider-service aborts stop by threadId (the session
  // id), so a stop issued after the new session started could kill it. The
  // agent loop additionally serializes its start behind any pending stop for
  // the same thread.
  const staleEntry = runnerHandles.get(session.id);
  if (staleEntry) {
    clearStopFallbackTimer(staleEntry);
    // Quarantine before abort: the replacement below becomes the session's
    // owner, so any late message from the retired handle must be dropped by
    // the onMessage stale-handle guard rather than mutate the new runner's
    // session id/model. Covers the prewarm-vs-send race where a booting
    // prewarm entry is installed after the send captured an empty slot and
    // is torn down here as the stale entry.
    userStoppedRunnerHandles.add(staleEntry.handle);
    staleEntry.handle.abort();
    runnerHandles.delete(session.id);
  }

  const handle = runAgentLoop({
    prompt,
    attachments,
    session: runnerSession,
    resumeSessionId,
    model: modelOverride,
    compatibleProviderId,
    betas: provider === 'claude' ? betasOverride || parseStoredBetas(session.betas) : undefined,
    claudeAccessMode: normalizedClaudeAccessMode,
    claudeExecutionMode: normalizedClaudeExecutionMode,
    claudeReasoningEffort,
    codexExecutionMode,
    codexPermissionMode,
    codexReasoningEffort,
    codexFastMode,
    kimiPermissionMode,
    grokPermissionMode,
    grokReasoningEffort,
    codexSkills: provider === 'codex' ? codexSkills : undefined,
    codexMentions: provider === 'codex' ? codexMentions : undefined,
    opencodePermissionMode,
    onMessage: (message) => {
      // A runner the user stopped that has since been retired or replaced is
      // dead to this session: NOTHING it emits may touch session state again
      // — not its drain, not its interrupted result, and especially not a
      // late `system init`, which would overwrite the replacement runner's
      // session id/model and broadcast stale status over the new run.
      if (userStoppedRunnerHandles.has(handle) && runnerHandles.get(session.id)?.handle !== handle) {
        return;
      }

      // 提取并保存 claude session id
      if (message.type === 'system' && message.subtype === 'init') {
        initMessage = message;
        if (provider === 'codex') {
          sessions.updateCodexSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else if (provider === 'opencode') {
          sessions.updateOpencodeSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else if (provider === 'kimi') {
          sessions.updateKimiSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else if (provider === 'grok') {
          sessions.updateGrokSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else if (provider === 'pi') {
          sessions.updatePiSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else {
          markClaudeInit(session.id);
          sessions.updateClaudeSessionId(session.id, message.session_id);
          const resolvedDisplayModel = reconcileClaudeDisplayModel(
            modelOverride || session.model,
            message.model
          );
          if (resolvedDisplayModel) {
            sessions.updateSessionModel(session.id, resolvedDisplayModel);
          }
        }

        broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: (sessions.getSession(session.id)?.status || 'running') as SessionStatus,
            scope: normalizeSessionScope(sessions.getSession(session.id)?.conversation_scope),
            agentId: sessions.getSession(session.id)?.agent_id || null,
            provider,
            model:
              provider === 'claude'
                ? reconcileClaudeDisplayModel(modelOverride || session.model, message.model)
                : message.model || modelOverride || undefined,
            compatibleProviderId:
              provider === 'claude'
                ? sessions.getSession(session.id)?.compatible_provider_id || compatibleProviderId
                : undefined,
            betas:
              provider === 'claude'
                ? betasOverride || parseStoredBetas(sessions.getSession(session.id)?.betas)
                : undefined,
            claudeAccessMode:
              provider === 'claude'
                ? normalizeClaudeAccessMode(
                    sessions.getSession(session.id)?.claude_access_mode || normalizedClaudeAccessMode
                  )
                : undefined,
            claudeExecutionMode:
              provider === 'claude'
                ? normalizeClaudeExecutionMode(
                    sessions.getSession(session.id)?.claude_execution_mode || normalizedClaudeExecutionMode,
                    sessions.getSession(session.id)?.claude_access_mode || normalizedClaudeAccessMode
                  )
                : undefined,
            claudeReasoningEffort:
              provider === 'claude'
                ? normalizeClaudeReasoningEffort(
                    sessions.getSession(session.id)?.claude_reasoning_effort || claudeReasoningEffort
                  )
                : undefined,
            codexExecutionMode:
              provider === 'codex'
                ? normalizeCodexExecutionMode(
                    sessions.getSession(session.id)?.codex_execution_mode || codexExecutionMode
                  )
                : undefined,
            codexPermissionMode:
              provider === 'codex'
                ? normalizeCodexPermissionMode(sessions.getSession(session.id)?.codex_permission_mode || codexPermissionMode)
                : undefined,
            codexReasoningEffort:
              provider === 'codex'
                ? normalizeCodexReasoningEffort(
                    sessions.getSession(session.id)?.codex_reasoning_effort || codexReasoningEffort
                  )
                : undefined,
            codexFastMode:
              provider === 'codex'
                ? normalizeCodexFastMode(sessions.getSession(session.id)?.codex_fast_mode ?? codexFastMode)
                : undefined,
            opencodePermissionMode:
              provider === 'opencode'
                ? normalizeOpenCodePermissionMode(
                    sessions.getSession(session.id)?.opencode_permission_mode || opencodePermissionMode
                  )
                : undefined,
            hiddenFromThreads: sessions.getSession(session.id)?.hidden_from_threads === 1,
          },
        });
      }

      if (message.type !== 'system' && message.type !== 'result') {
        sawTurnOutput = true;
      }
      // First-output latency must measure the model's first VISIBLE token, not
      // the host-minted `type: 'user'` prompt echo (emitted at prompt-enqueue
      // time), nor non-visible stream events (content_block_start, signature
      // deltas, or filtered subagent deltas) that precede the first rendered
      // text/thinking. Count a top-level assistant message or a top-level
      // text/thinking content_block_delta only.
      if (provider === 'claude' && !message.parentToolUseId) {
        const isVisibleDelta =
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          (message.event.delta?.type === 'text_delta' ||
            message.event.delta?.type === 'thinking_delta');
        if (message.type === 'assistant' || isVisibleDelta) {
          markClaudeFirstOutput(session.id);
        }
      }

      const sanitizedStreamMessage =
        // Subagent (Task) messages are excluded from every rebuilt transcript,
        // so unsigned thinking in them cannot poison a resume. Skip
        // sanitization entirely to keep that thinking visible in the nested
        // Task traces instead of stripping it (or the whole message).
        provider === 'claude' && !message.parentToolUseId
          ? sanitizeClaudeAssistantMessage(message)
          : { message, removedInvalidThinking: false };
      if (provider === 'claude' && sanitizedStreamMessage.removedInvalidThinking) {
        sessions.setClaudeSessionId(session.id, null);
        // The live CLI context still contains the invalid thinking block this
        // workaround strips; reusing the runner would replay the same API
        // failure. Doom it so the result handler retires it.
        const poisonedEntry = runnerHandles.get(session.id);
        if (poisonedEntry?.handle === handle) {
          poisonedEntry.doomed = true;
        }
      }

      // A user-interrupted turn ends with a non-success result by design; it
      // must read as 'idle', not as a failure. Results land oldest-turn
      // first, so the arriving result is a stopped turn's iff stopped turns
      // are still owed a result (see claude-stop-reconcile.ts). Classified
      // BEFORE the generic persist path: a stopped turn's terminal result
      // stays out of the transcript entirely — a hard-aborted turn never
      // produced one, and with a follow-up prompt already persisted it would
      // be recorded under the wrong turn.
      // Messages from a REPLACED stopped runner never get here — the guard
      // at the top of onMessage drops the whole stale handle — so the stop
      // classification only needs the live entry's counters.
      const entryForStop = runnerHandles.get(session.id);
      const stopStateForMessage =
        entryForStop?.handle === handle ? stopStateOf(entryForStop) : null;
      // Codex two-phase stop window (P0-6): while stopping, the interrupted
      // turn's result must not write/broadcast a status (the settle path owns
      // the final 'idle'), and its terminal result stays out of the
      // transcript — same semantics as Claude's stopped turns.
      const codexStopping =
        provider === 'codex' && stoppingCodexSessions.get(session.id)?.handle === handle;
      const stopClassification =
        codexStopping && message.type === 'result'
          ? { stoppedByUser: true, suppressStatusBroadcast: true }
          : message.type === 'result' && stopStateForMessage
            ? classifyResultForStop(stopStateForMessage)
            : { stoppedByUser: false, suppressStatusBroadcast: false };
      // The SDK keeps draining the interrupted turn (truncated assistant
      // output, tool results, stream events) between interrupt() and its
      // result. That drain is canceled work and — after a follow-up dispatch
      // — would be persisted and attributed under the follow-up's turn, so
      // it stays out of the transcript too. Serial-stream contract: nothing
      // from a follow-up turn can arrive before the stopped result lands;
      // the follow-up's own prompt echo is exempted by shape.
      const isStoppedTurnDrain =
        stopStateForMessage !== null &&
        stopStateForMessage.stoppedTurns > 0 &&
        isStoppedTurnDrainMessage(message);

      if (
        sanitizedStreamMessage.message &&
        !stopClassification.stoppedByUser &&
        !isStoppedTurnDrain
      ) {
        const activeEntry = runnerHandles.get(session.id);
        const turnAgentId =
          activeEntry?.activeAgentId ||
          activeAgentId ||
          session.agent_id ||
          null;
        const turnAgentRunId =
          activeEntry?.activeAgentRunId ||
          activeAgentRunId ||
          null;
        const attributedMessage = withAgentAttribution(
          sanitizedStreamMessage.message,
          turnAgentId,
          turnAgentRunId
        );
        // A subagent hitting an API error surfaces through its Task result;
        // its narration must not mark the whole session as failed.
        if (!attributedMessage.parentToolUseId) {
          localFailureMessage =
            localFailureMessage || detectLocalRunnerFailureMessage(extractAssistantText(attributedMessage));
        }
        const shouldPersistMessage = shouldPersistProviderMessage(attributedMessage);
        if (shouldPersistMessage) {
          // 保存消息
          sessions.addMessage(session.id, attributedMessage);
        }

        // Subagent stream_events have no renderer consumer: the store drops
        // them before touching state (they never enter messages or the
        // streaming buffer), so broadcasting them is pure IPC/parse waste —
        // during parallel Task runs they dominate delta traffic. Subagent
        // assistant/user messages still flow (nested traces need them).
        const isSubagentStreamEvent =
          attributedMessage.type === 'stream_event' && Boolean(attributedMessage.parentToolUseId);
        // Freeze the UI at the stop click: streaming deltas of a codex turn
        // being interrupted are not broadcast (they're never persisted, so
        // nothing is lost — the finalize message still lands below).
        const isCodexStoppingDelta =
          codexStopping && attributedMessage.type === 'stream_event';
        if (!isSubagentStreamEvent && !isCodexStoppingDelta) {
          // 广播消息
          broadcast(mainWindow, {
            type: 'stream.message',
            payload: { sessionId: session.id, message: attributedMessage },
          });
        }
        // Subagent internals are persisted for the nested traces but must
        // never surface as top-level replies in bridged chats.
        if (shouldPersistMessage && !attributedMessage.parentToolUseId) {
          void feishuBridge.handleSessionMessage(session.id, attributedMessage);
        }
      }

      // 检查是否为 result 消息，更新状态
      if (message.type === 'result') {
        // A reused runner serves many prompts; pop the one this turn ran
        // from the FIFO (results arrive in dispatch order), not the prompt
        // the runner was created with. A queued second prompt must never be
        // checked against the first turn's result.
        const entryForPrompt = runnerHandles.get(session.id);
        // Shift exactly once per result — stopped and suppressed results
        // included — or the FIFO skews against inFlightTurns. A stale
        // handle's result must NOT shift the replacement entry's queue.
        const queuedTurnPrompt =
          entryForPrompt?.handle === handle ? entryForPrompt.pendingTurnPrompts?.shift() : undefined;
        const turnPrompt = queuedTurnPrompt || prompt;
        const stoppedByUser = stopClassification.stoppedByUser;
        const slashFailureMessage =
          provider === 'claude' && !stoppedByUser
            ? detectSilentSlashCommandFailure(
                turnPrompt,
                initMessage,
                message,
                sawTurnOutput,
                session.cwd
              )
            : null;

        if (slashFailureMessage) {
          const activeEntry = runnerHandles.get(session.id);
          // The live CLI fixed its command/skill list at init and this turn
          // proved the list is stale (e.g. a user/project skill added after
          // spawn). Doom the runner so the retry respawns with a fresh scan —
          // keeping it would fail every retry the same way until the reaper.
          if (activeEntry?.handle === handle) {
            activeEntry.doomed = true;
          }
          const assistantMessage = withAgentAttribution(
            buildLocalAssistantMessage(slashFailureMessage),
            activeEntry?.activeAgentId || activeAgentId || session.agent_id || null,
            activeEntry?.activeAgentRunId || activeAgentRunId || null
          );
          sessions.addMessage(session.id, assistantMessage);
          broadcast(mainWindow, {
            type: 'stream.message',
            payload: { sessionId: session.id, message: assistantMessage },
          });
        }

        const explicitFailureMessage = localFailureMessage || slashFailureMessage;
        // This turn's terminal outcome…
        const turnStatus: SessionStatus =
          explicitFailureMessage || message.subtype !== 'success' ? 'error' : 'completed';
        // …but with another prompt still queued on this runner the session is
        // NOT done: a terminal DB status here would open the git/workspace
        // gates (which trust DB status alone) under a running agent. The last
        // queued result settles the session status.
        const hasQueuedTurns =
          provider === 'claude' &&
          entryForPrompt?.handle === handle &&
          (entryForPrompt.inFlightTurns ?? 1) > 1;
        const liveStatus: SessionStatus = hasQueuedTurns ? 'running' : turnStatus;
        const status: SessionStatus = stoppedByUser ? 'idle' : liveStatus;
        // A user-stopped turn's result writes and broadcasts NO status at
        // all: the stop already reported 'idle' synchronously, and anything
        // written since (a follow-up now running under the queued-turn hold,
        // a failed pre-dispatch send that set 'error') must not be
        // overwritten by this late result. Live results follow the
        // queued-turn rule above.
        const suppressStatusBroadcast = stopClassification.suppressStatusBroadcast;
        if (!suppressStatusBroadcast) {
          sessions.updateSessionStatus(session.id, status);
        }

        if (!suppressStatusBroadcast) broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status,
            scope: normalizeSessionScope(sessions.getSession(session.id)?.conversation_scope),
            agentId: sessions.getSession(session.id)?.agent_id || null,
            provider,
            model: sessions.getSession(session.id)?.model || modelOverride || undefined,
            compatibleProviderId:
              provider === 'claude'
                ? sessions.getSession(session.id)?.compatible_provider_id || compatibleProviderId
                : undefined,
            betas:
              provider === 'claude'
                ? betasOverride || parseStoredBetas(sessions.getSession(session.id)?.betas)
                : undefined,
            claudeAccessMode:
              provider === 'claude'
                ? normalizeClaudeAccessMode(
                    sessions.getSession(session.id)?.claude_access_mode || normalizedClaudeAccessMode
                  )
                : undefined,
            claudeExecutionMode:
              provider === 'claude'
                ? normalizeClaudeExecutionMode(
                    sessions.getSession(session.id)?.claude_execution_mode || normalizedClaudeExecutionMode,
                    sessions.getSession(session.id)?.claude_access_mode || normalizedClaudeAccessMode
                  )
                : undefined,
            claudeReasoningEffort:
              provider === 'claude'
                ? normalizeClaudeReasoningEffort(
                    sessions.getSession(session.id)?.claude_reasoning_effort || claudeReasoningEffort
                  )
                : undefined,
            codexExecutionMode:
              provider === 'codex'
                ? normalizeCodexExecutionMode(
                    sessions.getSession(session.id)?.codex_execution_mode || codexExecutionMode
                  )
                : undefined,
            codexPermissionMode:
              provider === 'codex'
                ? normalizeCodexPermissionMode(sessions.getSession(session.id)?.codex_permission_mode || codexPermissionMode)
                : undefined,
            codexReasoningEffort:
              provider === 'codex'
                ? normalizeCodexReasoningEffort(
                    sessions.getSession(session.id)?.codex_reasoning_effort || codexReasoningEffort
                  )
                : undefined,
            codexFastMode:
              provider === 'codex'
                ? normalizeCodexFastMode(sessions.getSession(session.id)?.codex_fast_mode ?? codexFastMode)
                : undefined,
            opencodePermissionMode:
              provider === 'opencode'
                ? normalizeOpenCodePermissionMode(
                    sessions.getSession(session.id)?.opencode_permission_mode || opencodePermissionMode
                  )
                : undefined,
            hiddenFromThreads: sessions.getSession(session.id)?.hidden_from_threads === 1,
          },
        });
        if (!suppressStatusBroadcast && !stoppedByUser && !hasQueuedTurns) {
          const latestSession = sessions.getSession(session.id);
          if (latestSession) {
            scheduleSessionEnvironmentRecapRefresh(latestSession, mainWindow);
          }
        }
        const currentEntry = runnerHandles.get(session.id);
        if (currentEntry?.handle === handle) {
          const turnDone = currentEntry.onTurnDone;
          currentEntry.onTurnDone = undefined;
          // onTurnDone consumers (automation runs) want the turn's own
          // terminal outcome, not the still-running session status.
          turnDone?.(turnStatus, explicitFailureMessage || undefined);
          if (provider === 'claude') {
            // The interrupted turn's result has landed — settle one stopped
            // turn; the hard-abort fallback stands down once none remain.
            if ((currentEntry.stoppedTurns ?? 0) > 0) {
              currentEntry.stoppedTurns = (currentEntry.stoppedTurns ?? 1) - 1 || undefined;
              if (!currentEntry.stoppedTurns) {
                clearStopFallbackTimer(currentEntry);
                currentEntry.stopFallbackAttempts = undefined;
              } else if (typeof currentEntry.handle.interrupt === 'function') {
                // Another user-stopped turn was queued behind the one that
                // just settled and is becoming active now. interrupt() only
                // ever cancels the ACTIVE turn, so the stop press that marked
                // it could not reach it — re-issue the interrupt for it here,
                // and re-arm the fallback in case even that goes unanswered.
                const entryToReinterrupt = currentEntry;
                entryToReinterrupt.handle
                  .interrupt!()
                  .catch(() => resolveStopFallback(mainWindow, session.id, entryToReinterrupt));
                clearStopFallbackTimer(entryToReinterrupt);
                entryToReinterrupt.stopFallbackAttempts = undefined;
                entryToReinterrupt.stopFallbackTimer = setTimeout(
                  () => resolveStopFallback(mainWindow, session.id, entryToReinterrupt),
                  STOP_INTERRUPT_FALLBACK_MS
                );
                entryToReinterrupt.stopFallbackTimer.unref?.();
              }
            }
            // Keep the runner alive for follow-up turns (streaming-input
            // reuse) — unless its live context is stale/poisoned (doomed) or
            // it is a one-shot auto-approving automation runner. A doomed
            // runner is only retired once NO turns remain in flight: a
            // stopped turn's result can land while a live follow-up is still
            // running here, and aborting then would kill that follow-up. The
            // reuse guard already refuses to dispatch new turns into a
            // doomed entry, so deferring loses nothing.
            currentEntry.inFlightTurns = Math.max(0, (currentEntry.inFlightTurns ?? 1) - 1);
            const drained = (currentEntry.inFlightTurns ?? 0) === 0;
            if (drained && (currentEntry.doomed || currentEntry.autoApprove)) {
              // Retire only once every queued turn has produced its result:
              // aborting earlier would drop a queued prompt that is already
              // persisted and counted, leaving the session without an ending
              // — or kill a live follow-up whose status update a stopped
              // result just suppressed.
              clearStopFallbackTimer(currentEntry);
              currentEntry.handle.abort();
              runnerHandles.delete(session.id);
              // Close the latency window only when the live runner has drained
              // its LAST turn — clearing on every result would delete a fast
              // follow-up's fresh window (dispatched after this turn's first
              // output, before its result) before it can log. A no-output
              // stop/interrupt still lands a result and drains, so a wedged
              // window is released here too.
              if (provider === 'claude') {
                clearClaudeTurnMetrics(session.id);
              }
            } else if (drained) {
              currentEntry.lastTurnEndedAt = Date.now();
              sweepIdleClaudeRunners();
              if (provider === 'claude') {
                clearClaudeTurnMetrics(session.id);
              }
            }
          }
        }
        // Reset per-turn detection state: the runner survives into the next
        // turn and turn-1 leftovers would otherwise misclassify it (a sticky
        // localFailureMessage marks every later turn as failed).
        localFailureMessage = null;
        sawTurnOutput = false;
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Runner error:', error);
      // A hard error may end the turn without a result — close the latency
      // window so it doesn't wedge the session's future measurements.
      if (provider === 'claude') {
        clearClaudeTurnMetrics(session.id);
      }

      // An idle (between-turns) Claude runner dying — OOM, external kill —
      // must not flip a completed session to error with a toast, and a turn
      // the user just stopped must not surface its teardown as a failure.
      // Drop the entry silently; the next send simply respawns. This silent
      // drop is only allowed while nothing live is lost: with a follow-up
      // turn dispatched after the stop, the error must surface normally or
      // that turn would vanish with the session stuck on 'running'.
      const mappedEntry = runnerHandles.get(session.id);
      if (
        provider === 'claude' &&
        mappedEntry?.handle === handle &&
        shouldDropRunnerErrorSilently(stopStateOf(mappedEntry))
      ) {
        clearStopFallbackTimer(mappedEntry);
        mappedEntry.handle.abort();
        runnerHandles.delete(session.id);
        return;
      }

      // A stale handle — this runner was already retired or replaced for ANY
      // reason (user stop, model/config change, provider switch, reaper) —
      // tearing down late is never the live session's failure: the session
      // is owned by its replacement runner, or by no runner at all. Only the
      // handle the map currently points at may flip the session to error;
      // surfacing a replaced runner's abort noise here was wrongly failing
      // healthy sessions on every reuse-rejected follow-up.
      if (mappedEntry?.handle !== handle) {
        return;
      }

      sessions.updateSessionStatus(session.id, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: 'error',
          scope: normalizeSessionScope(session.conversation_scope),
          agentId: session.agent_id || null,
          hiddenFromThreads: session.hidden_from_threads === 1,
        },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message, sessionId: session.id },
      });
      void feishuBridge.handleRunnerError(session.id, message);

      if (runnerHandles.get(session.id)?.handle === handle) {
        const currentEntry = runnerHandles.get(session.id);
        const turnDone = currentEntry?.onTurnDone;
        if (currentEntry) {
          currentEntry.onTurnDone = undefined;
          clearStopFallbackTimer(currentEntry);
        }
        turnDone?.('error', message);
        runnerHandles.delete(session.id);
      }
    },
    onClaudeExecutionModeChange: (mode, permissionMode) => {
      sessions.updateSessionClaudeAccessMode(session.id, permissionMode);
      sessions.updateSessionClaudeExecutionMode(session.id, mode);

      const current = sessions.getSession(session.id);
      const entry = runnerHandles.get(session.id);
      if (entry) {
        entry.claudeAccessMode = permissionMode;
        entry.claudeExecutionMode = mode;
      }

      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: (current?.status || 'running') as SessionStatus,
          provider,
          model: current?.model || modelOverride || undefined,
          compatibleProviderId:
            provider === 'claude'
              ? current?.compatible_provider_id || compatibleProviderId
              : undefined,
          betas:
            provider === 'claude'
              ? betasOverride || parseStoredBetas(current?.betas)
              : undefined,
          claudeAccessMode:
            provider === 'claude'
              ? normalizeClaudeAccessMode(permissionMode || current?.claude_access_mode || normalizedClaudeAccessMode)
              : undefined,
          claudeExecutionMode: provider === 'claude' ? mode : undefined,
          claudeReasoningEffort:
            provider === 'claude'
              ? normalizeClaudeReasoningEffort(current?.claude_reasoning_effort || claudeReasoningEffort)
              : undefined,
          codexExecutionMode:
            provider === 'codex'
              ? normalizeCodexExecutionMode(current?.codex_execution_mode || codexExecutionMode)
              : undefined,
          codexPermissionMode:
            provider === 'codex'
              ? normalizeCodexPermissionMode(current?.codex_permission_mode || codexPermissionMode)
              : undefined,
          codexReasoningEffort:
            provider === 'codex'
              ? normalizeCodexReasoningEffort(
                  current?.codex_reasoning_effort || codexReasoningEffort
                )
              : undefined,
          codexFastMode:
            provider === 'codex'
              ? normalizeCodexFastMode(current?.codex_fast_mode ?? codexFastMode)
              : undefined,
          opencodePermissionMode:
            provider === 'opencode'
              ? normalizeOpenCodePermissionMode(
                  current?.opencode_permission_mode || opencodePermissionMode
                )
              : undefined,
          hiddenFromThreads: current?.hidden_from_threads === 1,
        },
      });
    },
    onPermissionRequest: async (toolUseId, toolName, input) => {
      if (autoApprovePermissions) {
        return {
          behavior: 'allow',
          updatedInput:
            input && typeof input === 'object' && !Array.isArray(input)
              ? { ...(input as Record<string, unknown>) }
              : undefined,
          scope: 'session',
        };
      }
      // A permission request arriving AFTER the user stopped the turn it
      // belongs to must never surface a modal. Requests can only come from
      // the executing (oldest in-flight) turn, and while stopped turns still
      // owe results that turn is user-stopped and draining toward its
      // interrupt — deny with the same answer the stop path gives requests
      // that were already pending. A request from a stopped handle that has
      // since been replaced is equally dead.
      const permissionEntry = runnerHandles.get(session.id);
      if (
        (permissionEntry?.handle === handle &&
          shouldAutoDenyPermission(stopStateOf(permissionEntry))) ||
        (permissionEntry?.handle !== handle && userStoppedRunnerHandles.has(handle))
      ) {
        return { behavior: 'deny', message: 'The user stopped this turn.' };
      }
      // 广播权限请求
      broadcast(mainWindow, {
        type: 'permission.request',
        payload: {
          sessionId: session.id,
          toolUseId,
          toolName,
          input: input as PermissionRequestInput,
        },
      });
      void feishuBridge.handlePermissionRequest({
        sessionId: session.id,
        toolUseId,
        toolName,
        input: input as PermissionRequestInput,
      });

      // 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        sessionState.pendingPermissions.set(toolUseId, { resolve, reject });
      });
    },
    onPermissionDismissed: (toolUseId) => {
      // The provider resolved/abandoned the request itself (process death,
      // stop, serverRequest/resolved): settle the pending promise quietly and
      // drop the renderer card (P0-7).
      const pending = sessionState.pendingPermissions.get(toolUseId);
      if (pending) {
        pending.resolve({ behavior: 'deny', message: 'The request is no longer pending.' });
        sessionState.pendingPermissions.delete(toolUseId);
      }
      broadcast(mainWindow, {
        type: 'permission.dismissed',
        payload: { sessionId: session.id, toolUseId },
      });
    },
  });

  runnerHandles.set(session.id, {
    handle,
    provider,
    compatibleProviderId,
    claudeAccessMode: provider === 'claude' ? normalizedClaudeAccessMode : undefined,
    claudeExecutionMode: provider === 'claude' ? normalizedClaudeExecutionMode : undefined,
    claudeReasoningEffort:
      provider === 'claude' ? normalizeClaudeReasoningEffort(claudeReasoningEffort) : undefined,
    codexExecutionMode: provider === 'codex' ? normalizeCodexExecutionMode(codexExecutionMode) : undefined,
    codexPermissionMode: provider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
    codexReasoningEffort:
      provider === 'codex' ? normalizeCodexReasoningEffort(codexReasoningEffort) : undefined,
    codexFastMode:
      provider === 'codex' ? normalizeCodexFastMode(codexFastMode) : undefined,
	    opencodePermissionMode:
	      provider === 'opencode' ? normalizeOpenCodePermissionMode(opencodePermissionMode) : undefined,
	    kimiPermissionMode: provider === 'kimi' ? normalizeKimiPermissionMode(kimiPermissionMode) : undefined,
    grokPermissionMode:
      provider === 'grok' ? normalizeGrokPermissionMode(grokPermissionMode) : undefined,
    grokReasoningEffort:
      provider === 'grok' ? normalizeGrokReasoningEffort(grokReasoningEffort) : undefined,
    activeAgentId: normalizedActiveAgentId,
    activeAgentRunId: normalizedActiveAgentRunId,
    onTurnDone,
    // A prewarmed runner has NO dispatched turn: the FIFO must stay aligned
    // with inFlightTurns (a phantom '' entry would let the first real result
    // shift the wrong prompt into slash-failure detection), and the idle
    // anchor is stamped now so the reaper's prewarm TTL applies — without it
    // the entry would never be a reap candidate and would leak.
    inFlightTurns: prewarmRunner ? 0 : 1,
    pendingTurnPrompts: prewarmRunner ? [] : [prompt],
    lastTurnEndedAt: prewarmRunner ? Date.now() : undefined,
    prewarmed: prewarmRunner || undefined,
    autoApprove: autoApprovePermissions || undefined,
    cwd: runnerSession.cwd || null,
  });

  if (provider === 'claude') {
    ensureClaudeRunnerReaper();
  }
}

/** At most this many idle prewarmed runners may exist at once. */
const MAX_PREWARMED_RUNNERS = 2;

function countIdlePrewarmedRunners(): { count: number; oldest: string | null } {
  let count = 0;
  let oldest: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [sessionId, entry] of runnerHandles) {
    if (entry.provider !== 'claude' || entry.prewarmed !== true) continue;
    if ((entry.inFlightTurns ?? 0) > 0) continue;
    count += 1;
    const anchor = entry.lastTurnEndedAt ?? 0;
    if (anchor < oldestAt) {
      oldestAt = anchor;
      oldest = sessionId;
    }
  }
  return { count, oldest };
}

// 预热 Claude runner(P3):在用户开始输入时投机启动 CLI,把 spawn +
// settings/插件加载 + MCP 连接的冷启动成本移出首条消息的关键路径。
async function handleRunnerPrewarm(
  mainWindow: BrowserWindow,
  payload: import('../shared/types').RunnerPrewarmPayload
): Promise<void> {
  const sessionId = payload.sessionId?.trim();
  if (!sessionId) return;

  const initial = sessions.getSession(sessionId);
  if (!initial) return;
  // Claude only — other providers run through adapter sessions with
  // different lifecycles.
  if ((initial.provider || 'claude') !== 'claude') return;
  // External Claude sessions are read-only; never spawn for them.
  if (initial.session_origin === 'claude_remote') return;
  if (initial.status === 'running') return;
  if (runnerHandles.has(sessionId)) return;

  // History-bootstrap guard: a session WITH recorded history but WITHOUT a
  // live claude_session_id relies on the send path's
  // bootstrapClaudeSessionFromHistory fall-through. A prewarmed entry would
  // short-circuit that path and the model would answer with empty context —
  // silent data loss. Skip those sessions entirely.
  const resumeCandidate = initial.claude_session_id ?? undefined;
  if (!resumeCandidate && sessions.getSessionHistory(sessionId).length > 0) {
    return;
  }

  const runtimeStatus = await getClaudeRuntimeStatusCached(payload.model || null);
  if (!runtimeStatus.ready) return;

  // ── SYNC re-check. The await above yielded; a real send may have started a
  // runner for this session in the meantime, and startRunner unconditionally
  // aborts an existing entry — prewarming now would KILL the user's live
  // turn. Nothing below this line may await before startRunner.
  const session = sessions.getSession(sessionId);
  if (!session || session.status === 'running') return;
  if (runnerHandles.has(sessionId)) return;
  const resumeSessionId = session.claude_session_id ?? undefined;
  if (!resumeSessionId && resumeCandidate) {
    // claude_session_id was cleared while we awaited (history sanitize) —
    // the bootstrap guard above no longer holds. Bail.
    return;
  }

  // Cap the speculative fleet: each prewarmed runner is a full CLI process
  // tree with every global MCP server. Evict the oldest prewarmed entry
  // (never a real warm runner) to make room.
  const { count, oldest } = countIdlePrewarmedRunners();
  if (count >= MAX_PREWARMED_RUNNERS && oldest) {
    const evicted = runnerHandles.get(oldest);
    if (evicted) {
      clearStopFallbackTimer(evicted);
      // Quarantine the handle before aborting: if this booting prewarm ever
      // emits a late message (e.g. an init racing the abort) after a real
      // runner has taken over that session, the onMessage stale-handle guard
      // must drop it so it can't overwrite the live runner's session id/model.
      // (A promptless prewarm emits no init today — this is a hard invariant,
      // not a live race.)
      userStoppedRunnerHandles.add(evicted.handle);
      evicted.handle.abort();
      runnerHandles.delete(oldest);
    }
  }

  // Merge payload over the session row with the SAME expressions the
  // session.continue path uses (7849-7866) — the reuse check compares the
  // entry's normalized values against merged-and-normalized send payloads,
  // and any asymmetry here turns the prewarm into a net loss (abort + second
  // cold start on the first real send).
  const nextModel = normalizeModel(payload.model ?? session.model ?? undefined);
  const nextCompatibleProviderId =
    payload.compatibleProviderId ?? (session.compatible_provider_id || undefined);
  const nextBetas = normalizeBetas(payload.betas ?? parseStoredBetas(session.betas));
  const previousAccessMode = normalizeClaudeAccessMode(session.claude_access_mode);
  const nextAccessMode = normalizeClaudeAccessMode(payload.claudeAccessMode || previousAccessMode);
  const previousExecutionMode = normalizeClaudeExecutionMode(
    session.claude_execution_mode,
    previousAccessMode
  );
  const nextExecutionMode = normalizeClaudeExecutionMode(
    payload.claudeExecutionMode || previousExecutionMode,
    nextAccessMode
  );
  const nextReasoningEffort = normalizeClaudeReasoningEffort(
    payload.claudeReasoningEffort || normalizeClaudeReasoningEffort(session.claude_reasoning_effort)
  );

  // The send-path reuse check compares model / compatibleProvider / betas
  // against the SESSION ROW (not the runner entry — unlike access/execution/
  // effort, which read the entry). So if the composer carries an unsaved
  // change to any of those three, the first real send would see it as a
  // change and abort this prewarmed runner, paying a wasted spawn on top of
  // the cold start. Skip prewarm entirely in that case — the send then cold-
  // starts exactly once, as it would with no prewarm. Uses the same
  // comparators the reuse check uses so the two decisions stay symmetric.
  const rowModel = normalizeModel(session.model ?? undefined);
  const rowCompatibleProviderId = session.compatible_provider_id || undefined;
  const rowBetas = normalizeBetas(parseStoredBetas(session.betas));
  const configDivergesFromRow =
    !isSameClaudeModelSelection(nextModel, rowModel) ||
    nextCompatibleProviderId !== rowCompatibleProviderId ||
    JSON.stringify(nextBetas || []) !== JSON.stringify(rowBetas || []);
  if (configDivergesFromRow) {
    return;
  }

  if (isDev()) {
    console.log('[Runner Prewarm]', {
      sessionId,
      hasResume: Boolean(resumeSessionId),
      model: nextModel,
    });
  }

  startRunner(
    mainWindow,
    session,
    '', // empty prompt — boots the CLI without dispatching a turn
    resumeSessionId,
    undefined,
    'claude',
    nextModel,
    nextCompatibleProviderId,
    nextBetas,
    nextAccessMode,
    nextExecutionMode,
    nextReasoningEffort,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    null,
    false,
    true // prewarmRunner
  );
}

// 获取会话历史
function handleSessionHistory(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  void (async () => {
    const unifiedSession = toUnifiedSessionRecord(session);
    const source = getHistorySourceForSession(unifiedSession);
    const page = await source.loadLatest(unifiedSession, 100);
    const messages = page.messages;
    const finalMessages =
      session.provider === 'claude' && session.session_origin === 'aegis'
        ? sanitizeStoredClaudeHistory(sessionId, messages).messages
        : messages;

    broadcast(mainWindow, {
      type: 'session.history',
      payload: {
        sessionId,
        status: session.status as SessionInfo['status'],
        messages: finalMessages,
        cursor: page.cursor,
        hasMore: page.hasMore,
      },
    });
  })().catch((error) => {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: {
        message: error instanceof Error ? error.message : 'Failed to load session history.',
        sessionId,
      },
    });
  });
}

// 停止会话
function hardStopClaudeRunner(sessionId: string, entry: RunnerEntry): void {
  if (runnerHandles.get(sessionId) !== entry) return;
  clearStopFallbackTimer(entry);
  entry.handle.abort();
  runnerHandles.delete(sessionId);
}

/**
 * A soft stop failed to reconcile — `interrupt()` rejected, or the
 * interrupted turn's result never landed within the fallback window. Only
 * hard-abort silently when every in-flight turn is a stopped one; a follow-up
 * turn the user dispatched after the stop shares this runner and must never
 * be killed quietly. While a follow-up is live the fallback re-arms (keeping
 * the stop attribution so a slow interrupted result still maps to idle), and
 * once the escalation budget is spent — the serial stream is wedged and the
 * queued follow-up can never complete — it reclaims the runner and SURFACES
 * the failure so the session never sticks on 'running' with no way out.
 */
function resolveStopFallback(mainWindow: BrowserWindow, sessionId: string, entry: RunnerEntry): void {
  if (runnerHandles.get(sessionId) !== entry) return;
  const attempt = (entry.stopFallbackAttempts ?? 0) + 1;
  entry.stopFallbackAttempts = attempt;
  const action = resolveStopFallbackAction(stopStateOf(entry), attempt);
  switch (action) {
    case 'stand-down':
      clearStopFallbackTimer(entry);
      entry.stopFallbackAttempts = undefined;
      return;
    case 'hard-abort':
      // Nothing live on this runner: the stop already reported 'idle'.
      hardStopClaudeRunner(sessionId, entry);
      return;
    case 're-arm':
      clearStopFallbackTimer(entry);
      entry.stopFallbackTimer = setTimeout(
        () => resolveStopFallback(mainWindow, sessionId, entry),
        STOP_INTERRUPT_FALLBACK_MS
      );
      entry.stopFallbackTimer.unref?.();
      return;
    case 'reclaim-and-surface': {
      hardStopClaudeRunner(sessionId, entry);
      const session = sessions.getSession(sessionId);
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId,
          status: 'error',
          scope: normalizeSessionScope(session?.conversation_scope),
          agentId: session?.agent_id || null,
          hiddenFromThreads: session?.hidden_from_threads === 1,
        },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message:
            'The stopped turn never finished shutting down, so the runner was closed before your queued message could run. Please send it again.',
          sessionId,
        },
      });
      return;
    }
  }
}

/** How long to wait for an interrupted turn's result before hard-aborting. */
const STOP_INTERRUPT_FALLBACK_MS = 8_000;

function handleSessionStop(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  const entry = runnerHandles.get(sessionId);
  let softStopped = false;
  if (entry) {
    const turnDone = entry.onTurnDone;
    entry.onTurnDone = undefined;
    turnDone?.('idle');
    const canSoftInterrupt =
      entry.provider === 'claude' &&
      typeof entry.handle.interrupt === 'function' &&
      (entry.inFlightTurns ?? 0) > 0;
    // A stopped handle may finish tearing down only after it has been
    // replaced; remember it so its late onError noise stays silent.
    userStoppedRunnerHandles.add(entry.handle);
    softStopped = canSoftInterrupt;

    // Codex two-phase stop (P0-6): request the interrupt and settle on the
    // provider's confirmation ('turn/completed(interrupted)') instead of
    // pretending the turn stopped the moment the button was clicked.
    const canCodexTwoPhase =
      entry.provider === 'codex' &&
      typeof entry.handle.interruptAndSettle === 'function' &&
      !stoppingCodexSessions.has(sessionId);
    if (canCodexTwoPhase) {
      const stopHandle = entry.handle;
      const settlePromise = stopHandle.interruptAndSettle!();
      stoppingCodexSessions.set(sessionId, { handle: stopHandle, settlePromise });

      // Pending permission promises resolve as a clean deny (the provider
      // declines+dismisses its own pending approvals at settle).
      const codexState = sessionStates.get(sessionId);
      if (codexState) {
        for (const [, pending] of codexState.pendingPermissions) {
          pending.resolve({ behavior: 'deny', message: 'The user stopped this turn.' });
        }
        codexState.pendingPermissions.clear();
      }

      // Broadcast-only 'stopping' — the DB stays 'running' until settle
      // (persisting it would open git/workspace gates mid-turn and strand
      // the session after a crash; the boot sweep only resets 'running').
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId,
          status: 'stopping',
          hiddenFromThreads: session?.hidden_from_threads === 1,
        },
      });

      void settlePromise.then(({ confirmed }) => {
        stoppingCodexSessions.delete(sessionId);
        // Retire the runner entry (staleness-guarded: a replacement runner
        // may already own this session key).
        const currentEntry = runnerHandles.get(sessionId);
        const isStopInitiator = currentEntry?.handle === stopHandle;
        if (isStopInitiator) {
          clearStopFallbackTimer(currentEntry);
          runnerHandles.delete(sessionId);
        } else if (currentEntry) {
          // A replacement is live — do not touch its status. The stop of the
          // old turn is complete as far as this session is concerned.
          return;
        }

        sessions.updateSessionStatus(sessionId, 'idle');
        broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId,
            status: 'idle',
            hiddenFromThreads: sessions.getSession(sessionId)?.hidden_from_threads === 1,
          },
        });

        if (!confirmed) {
          const warning = buildLocalAssistantMessage(
            'Codex did not confirm the stop within 10s; the turn may still be finishing server-side.'
          );
          sessions.addMessage(sessionId, warning);
          broadcast(mainWindow, {
            type: 'stream.message',
            payload: { sessionId, message: warning },
          });
        }
      });
      return;
    }

    if (canSoftInterrupt) {
      // A prompt still being prepared (async attachment reads) must never
      // start a turn after the stop: drop it before it reaches the input
      // queue and remove it from the turn accounting — a cancelled prompt
      // never produces a result the reconcile bookkeeping could wait for.
      // The prompt FIFO is trimmed in lockstep: cancelled prompts are the
      // most recent dispatches (the tail), and leaving them would skew the
      // per-result shift against inFlightTurns, misattributing every later
      // turn's slash-failure prompt.
      const cancelledPrompts = entry.handle.cancelPendingPrompts?.() ?? 0;
      if (cancelledPrompts > 0) {
        entry.inFlightTurns = Math.max(0, (entry.inFlightTurns ?? 0) - cancelledPrompts);
        entry.pendingTurnPrompts?.splice(-cancelledPrompts);
      }
      if ((entry.inFlightTurns ?? 0) === 0) {
        // Everything the stop caught was still being prepared — nothing
        // reached the CLI, so there is no turn to interrupt and no result
        // to await. The runner stays warm and idle for the next send.
        clearStopFallbackTimer(entry);
        entry.stoppedTurns = undefined;
        entry.stopFallbackAttempts = undefined;
        entry.lastTurnEndedAt = Date.now();
        // A cancelled-before-dispatch turn produces no result, so close its
        // latency window here — otherwise it stays half-open and blocks every
        // later measurement for the session.
        if (entry.provider === 'claude') {
          clearClaudeTurnMetrics(sessionId);
        }
      } else {
        // Soft stop: interrupt the in-flight turn but keep the runner (and
        // its warm context) alive so the next send skips the cold respawn.
        // The interrupted turn still emits a result; the stopped-turn count
        // makes the result handler report 'idle' instead of an error.
        // Failures to reconcile go through resolveStopFallback, which never
        // silently destroys a runner that carries a live follow-up turn.
        entry.stoppedTurns = markTurnsStopped(stopStateOf(entry));
        entry.stopFallbackAttempts = undefined;
        entry.handle.interrupt!().catch(() => resolveStopFallback(mainWindow, sessionId, entry));
        if (entry.stopFallbackTimer) {
          clearTimeout(entry.stopFallbackTimer);
        }
        entry.stopFallbackTimer = setTimeout(
          () => resolveStopFallback(mainWindow, sessionId, entry),
          STOP_INTERRUPT_FALLBACK_MS
        );
        entry.stopFallbackTimer.unref?.();
      }
    } else {
      clearStopFallbackTimer(entry);
      entry.handle.abort();
      runnerHandles.delete(sessionId);
      // Hard abort: no result is coming for any open latency window on this
      // session — close it so it can't wedge later measurements.
      if (entry.provider === 'claude') {
        clearClaudeTurnMetrics(sessionId);
      }
    }
  }

  // Settle all pending permissions. On the soft-stop path the runner stays
  // alive, so the awaited promise must RESOLVE as a clean deny: the SDK's
  // canUseTool consumes it and answers the CLI's permission control request,
  // and interrupt() then ends the turn without an error. A rejection would
  // instead surface through the SDK as an error control response — teardown
  // noise the warm runner (and any queued follow-up) must not eat. Rejection
  // stays only on the hard-abort path, where the process dies anyway.
  const state = sessionStates.get(sessionId);
  if (state) {
    for (const [, pending] of state.pendingPermissions) {
      if (softStopped) {
        pending.resolve({ behavior: 'deny', message: 'The user stopped this turn.' });
      } else {
        pending.reject(new Error('Session aborted'));
      }
    }
    state.pendingPermissions.clear();
  }

  // 更新状态为 idle（stop 不算 error）
  sessions.updateSessionStatus(sessionId, 'idle');

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'idle',
      hiddenFromThreads: session?.hidden_from_threads === 1,
    },
  });
}

// 删除会话
function handleSessionDelete(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  if (session?.session_origin === 'claude_remote') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'External Claude sessions are read-only in Aegis.', sessionId },
    });
    return;
  }

  // 先停止运行中的会话
  const entry = runnerHandles.get(sessionId);
  if (entry) {
    const turnDone = entry.onTurnDone;
    entry.onTurnDone = undefined;
    turnDone?.('idle');
    clearStopFallbackTimer(entry);
    entry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 清理状态
  sessionStates.delete(sessionId);
  clearClaudeTurnMetrics(sessionId);

  // 删除数据库记录
  sessions.deleteSession(sessionId);

  // worktree 回收（clean 且无其它 session 引用才回收，dirty 保留）
  if (session?.worktree_path) {
    void recycleSessionWorktree(session);
  }

  // 广播删除事件（幂等）
  broadcast(mainWindow, {
    type: 'session.deleted',
    payload: { sessionId },
  });
}

// 处理权限响应
function handlePermissionResponse(
  payload: PermissionResponsePayload
): boolean {
  const { sessionId, toolUseId, result } = payload;

  const state = sessionStates.get(sessionId);
  if (!state) return false;

  const pending = state.pendingPermissions.get(toolUseId);
  if (pending) {
    pending.resolve(result);
    state.pendingPermissions.delete(toolUseId);
    return true;
  }
  return false;
}

// 获取 MCP 配置（返回全局和项目级分开，同时包含 Codex 的 MCP 配置）
function handleMcpGetConfig(mainWindow: BrowserWindow, projectPath?: string): void {
  const globalServers = getGlobalMcpServers();
  const projectServers = projectPath ? getProjectMcpServers(projectPath) : {};
  const codexGlobalServers = getCodexMcpServers();
  const opencodeGlobalServers = getOpencodeMcpServers();
  const opencodeProjectServers = projectPath ? getOpencodeProjectMcpServers(projectPath) : {};
  const kimiGlobalServers = getKimiMcpServers();
  const kimiProjectServers = projectPath ? getKimiProjectMcpServers(projectPath) : {};

  // 合并用于向后兼容
  const mergedServers = { ...globalServers, ...projectServers };

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: mergedServers,  // 向后兼容
      globalServers,
      projectServers,
      codexGlobalServers,
      opencodeGlobalServers,
      opencodeProjectServers,
      kimiGlobalServers,
      kimiProjectServers,
    },
  });
}

// 保存 MCP 配置
function handleMcpSaveConfig(
  mainWindow: BrowserWindow,
  payload: {
    servers?: Record<string, McpServerConfig>;
    globalServers?: Record<string, McpServerConfig>;
    projectServers?: Record<string, McpServerConfig>;
    codexGlobalServers?: Record<string, McpServerConfig>;
    opencodeGlobalServers?: Record<string, McpServerConfig>;
    opencodeProjectServers?: Record<string, McpServerConfig>;
    kimiGlobalServers?: Record<string, McpServerConfig>;
    kimiProjectServers?: Record<string, McpServerConfig>;
    projectPath?: string;
  }
): void {
  // 保存 Claude 全局配置
  let claudeMcpChanged = false;
  if (payload.globalServers !== undefined) {
    saveMcpServers(payload.globalServers);
    claudeMcpChanged = true;
  } else if (payload.servers !== undefined) {
    // 向后兼容
    saveMcpServers(payload.servers);
    claudeMcpChanged = true;
  }

  // 保存 Claude 项目级配置
  if (payload.projectPath && payload.projectServers !== undefined) {
    saveProjectMcpServers(payload.projectPath, payload.projectServers);
    claudeMcpChanged = true;
  }

  if (claudeMcpChanged) {
    // Live runners spawned their MCP children from the previous config;
    // retire them so the next turn connects to the updated servers.
    flushClaudeRunners();
  }

  // 保存 Codex 全局配置（写入 ~/.codex/config.toml）
  if (payload.codexGlobalServers !== undefined) {
    try {
      saveCodexMcpServers(payload.codexGlobalServers);
    } catch (error) {
      console.warn('Failed to save Codex MCP servers:', error);
    }
  }

  // 保存 OpenCode 全局配置（写入 ~/.config/opencode/opencode.json）
  if (payload.opencodeGlobalServers !== undefined) {
    try {
      saveOpencodeMcpServers(payload.opencodeGlobalServers);
    } catch (error) {
      console.warn('Failed to save OpenCode MCP servers:', error);
    }
  }

  // 保存 OpenCode 项目级配置（写入 <项目根>/opencode.json）
  if (payload.projectPath && payload.opencodeProjectServers !== undefined) {
    try {
      saveOpencodeProjectMcpServers(payload.projectPath, payload.opencodeProjectServers);
    } catch (error) {
      console.warn('Failed to save OpenCode project MCP servers:', error);
    }
  }

  // 保存 Kimi 全局配置（写入 ~/.kimi/mcp.json）
  if (payload.kimiGlobalServers !== undefined) {
    try {
      saveKimiMcpServers(payload.kimiGlobalServers);
    } catch (error) {
      console.warn('Failed to save Kimi MCP servers:', error);
    }
  }

  // 保存 Kimi 项目级配置（写入 <项目根>/.kimi-code/mcp.json）
  if (payload.projectPath && payload.kimiProjectServers !== undefined) {
    try {
      saveKimiProjectMcpServers(payload.projectPath, payload.kimiProjectServers);
    } catch (error) {
      console.warn('Failed to save Kimi project MCP servers:', error);
    }
  }

  // 返回更新后的配置
  const globalServers = getGlobalMcpServers();
  const projectServers = payload.projectPath ? getProjectMcpServers(payload.projectPath) : {};
  const codexGlobalServers = getCodexMcpServers();
  const opencodeGlobalServers = getOpencodeMcpServers();
  const opencodeProjectServers = payload.projectPath ? getOpencodeProjectMcpServers(payload.projectPath) : {};
  const kimiGlobalServers = getKimiMcpServers();
  const kimiProjectServers = payload.projectPath ? getKimiProjectMcpServers(payload.projectPath) : {};

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: globalServers,
      globalServers,
      projectServers,
      codexGlobalServers,
      opencodeGlobalServers,
      opencodeProjectServers,
      kimiGlobalServers,
      kimiProjectServers,
    },
  });
}

function handleSkillsList(mainWindow: BrowserWindow, projectPath?: string): void {
  broadcast(mainWindow, {
    type: 'skills.list',
    payload: listClaudeSkills(projectPath),
  });
}

// 切换会话置顶状态
function handleSessionTogglePin(
  mainWindow: BrowserWindow,
  payload: { sessionId: string }
): void {
  const newPinned = sessions.toggleSessionPinned(payload.sessionId);
  broadcast(mainWindow, {
    type: 'session.pinned',
    payload: { sessionId: payload.sessionId, pinned: newPinned },
  });
}

// 文件夹列表
function handleFolderList(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 创建文件夹
function handleFolderCreate(
  mainWindow: BrowserWindow,
  payload: { path: string; displayName?: string }
): void {
  try {
    folderConfig.createFolder(payload.path, payload.displayName);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to create folder: ${String(error)}` },
    });
  }
}

// 更新文件夹
function handleFolderUpdate(
  mainWindow: BrowserWindow,
  payload: { path: string; updates: Partial<FolderConfig> }
): void {
  try {
    folderConfig.updateFolder(payload.path, payload.updates);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to update folder: ${String(error)}` },
    });
  }
}

// 删除文件夹
function handleFolderDelete(
  mainWindow: BrowserWindow,
  payload: { path: string }
): void {
  try {
    folderConfig.deleteFolder(payload.path);
    // 清除该文件夹下所有 session 的文件夹路径
    sessions.clearSessionsFolderPath(payload.path);
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to delete folder: ${String(error)}` },
    });
  }
}

// 移动/重命名文件夹
function handleFolderMove(
  mainWindow: BrowserWindow,
  payload: { oldPath: string; newPath: string }
): void {
  try {
    const { oldPaths, newPaths } = folderConfig.moveFolder(payload.oldPath, payload.newPath);
    // 更新 session 的文件夹路径
    for (let i = 0; i < oldPaths.length; i++) {
      sessions.updateSessionsInFolder(oldPaths[i], newPaths[i]);
    }
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to move folder: ${String(error)}` },
    });
  }
}

// 设置 session 文件夹
function handleSessionSetFolder(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; folderPath: string | null }
): void {
  try {
    // 如果设置了文件夹路径，确保文件夹存在
    if (payload.folderPath) {
      folderConfig.ensureFolderExists(payload.folderPath);
    }
    sessions.updateSessionFolderPath(payload.sessionId, payload.folderPath);
    broadcast(mainWindow, {
      type: 'session.folderChanged',
      payload: { sessionId: payload.sessionId, folderPath: payload.folderPath },
    });
    // 如果创建了新文件夹，广播文件夹变更
    if (payload.folderPath) {
      broadcastFolderChanged(mainWindow);
    }
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to set session folder: ${String(error)}` },
    });
  }
}

// 设置 session 所属 channel
function handleSessionSetChannel(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; channelId: string }
): void {
  try {
    const channelId = normalizeWorkspaceChannelId(payload.channelId);
    sessions.updateSessionChannelId(payload.sessionId, channelId);
    broadcast(mainWindow, {
      type: 'session.channelChanged',
      payload: { sessionId: payload.sessionId, channelId },
    });
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to set session channel: ${String(error)}` },
    });
  }
}

function handleSessionSetTeam(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; teamMode: SessionTeamMode; teamId?: string | null }
): void {
  try {
    const teamMode = normalizeSessionTeamMode(payload.teamMode);
    const teamId = teamMode === 'team' || teamMode === 'manual'
      ? payload.teamId?.trim() || null
      : null;
    sessions.updateSessionTeam(payload.sessionId, teamMode, teamId);
    broadcast(mainWindow, {
      type: 'session.teamChanged',
      payload: { sessionId: payload.sessionId, teamMode, teamId },
    });
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to set session team: ${String(error)}` },
    });
  }
}

// 广播文件夹变更
function broadcastFolderChanged(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.changed',
    payload: { folders },
  });
}

// 清理资源
export function cleanup(): void {
  ipcMain.removeAllListeners('client-event');
  automationScheduler?.stop();
  automationScheduler = null;
  stopClaudeRunnerReaper();
  disposeTerminalTransportServer();
  disposeTerminalRuntime();
  // 停止所有运行中的 runner
  for (const [, entry] of runnerHandles) {
    entry.handle.abort();
  }
  runnerHandles.clear();
  sessionStates.clear();
  for (const [, entry] of localPreviewServers) {
    entry.server.close();
  }
  localPreviewServers.clear();

  // 关闭数据库
  sessions.close();
}
