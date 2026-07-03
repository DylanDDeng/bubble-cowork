import { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { setupIPCHandlers, cleanup } from './ipc-handlers';
import { registerBrowserIpc, disposeBrowserIpc } from './browser-ipc';
import { browserManager } from './browserManager';
import { isDev, getPreloadPath, getUIPath, DEV_SERVER_URL, ipcMainHandle } from './util';
import { ensureShellEnvironment } from './libs/shell-environment';
import { listRunningSessions } from './libs/session-store';
import type { AppUpdateStatus } from '../shared/types';

// close 确认用：数据库未初始化等异常一律按 0 处理，绝不阻塞关窗
function countRunningSessionsSafe(): number {
  try {
    return listRunningSessions().length;
  } catch {
    return 0;
  }
}

// 修复打包后的环境变量问题（macOS/Linux GUI 应用无法继承 shell 的环境变量）。
// 细节见 src/electron/libs/shell-environment.ts：使用 interactive + login shell 抓 env
// （让 .zshrc / .bashrc 里 nvm、volta、fnm 等 CLI 管理器生效），失败时用基于磁盘存在性的
// 常见路径兜底（含 nvm/fnm/asdf 各自的 node bin 目录）。
ensureShellEnvironment();

// 禁用 macOS 窗口恢复提示（避免强制退出后弹出 "reopen windows" 对话框卡住启动）
if (process.platform === 'darwin') {
  try {
    const savedStatePath = path.join(
      app.getPath('home'),
      'Library',
      'Saved Application State',
      'com.github.electron.savedState'
    );
    if (fs.existsSync(savedStatePath)) {
      fs.rmSync(savedStatePath, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

function configureUserDataPath(): void {
  // Explicit isolation for tests and fresh-user simulation. macOS resolves
  // appData through system APIs that ignore $HOME, so an env override is the
  // only reliable way to point a launch at a sandboxed data directory.
  const override = process.env.AEGIS_USER_DATA_DIR?.trim();
  if (override) {
    const resolved = path.resolve(override);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      console.warn('[main] Failed to create AEGIS_USER_DATA_DIR, using default userData:', error);
      return;
    }
    app.setPath('userData', resolved);
    console.log('[main] userData overridden via AEGIS_USER_DATA_DIR:', resolved);
    return;
  }

  if (!isDev()) {
    return;
  }

  const devUserDataPath = path.join(app.getPath('appData'), 'Aegis Dev');
  app.setPath('userData', devUserDataPath);
}

configureUserDataPath();

let mainWindow: BrowserWindow | null = null;
let updaterInitialized = false;
let devFileWatcher: fs.FSWatcher | null = null;
let updateCheckStarted = false;
let pendingManualUpdateCheck = false;
let latestUpdateStatus: AppUpdateStatus = {
  available: false,
  version: null,
  autoDetected: false,
};
let latestUiResumeState: import('../shared/types').UiResumeState | null = null;
let isQuitting = false;
let allowCloseAfterProjectEditorFlush = false;
let projectEditorCloseFlushInProgress = false;

// Mirror the current unsaved editor content in the main process so close/quit
// can write it synchronously without depending on late renderer IPC.
type PendingProjectEditorDraft = {
  cwd: string;
  filePath: string;
  content: string;
};
let pendingProjectEditorDraft: PendingProjectEditorDraft | null = null;
const EDITABLE_PROJECT_EDITOR_EXTENSIONS = new Set(['.txt', '.md', '.mdx']);
let handledTerminationSignal = false;

function setPendingProjectEditorDraft(draft: PendingProjectEditorDraft | null): void {
  pendingProjectEditorDraft =
    draft && typeof draft.filePath === 'string' && draft.filePath.length > 0
      ? { cwd: draft.cwd || '', filePath: draft.filePath, content: draft.content ?? '' }
      : null;
}

// Synchronous close/quit fallback. Only writes existing editable text files
// inside the current project root.
function flushPendingProjectEditorDraftSync(): void {
  const draft = pendingProjectEditorDraft;
  if (!draft) return;
  pendingProjectEditorDraft = null;
  try {
    const root = path.resolve(draft.cwd || '.');
    const resolved = path.resolve(root, draft.filePath || '');
    const ext = path.extname(resolved).toLowerCase();
    if (!EDITABLE_PROJECT_EDITOR_EXTENSIONS.has(ext)) {
      return;
    }
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return;
    }
    const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
    if (!stat?.isFile()) {
      return;
    }
    const tempPath = path.join(
      path.dirname(resolved),
      `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, draft.content ?? '', { encoding: 'utf8', mode: stat.mode });
      fs.renameSync(tempPath, resolved);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failures
      }
    }
  } catch (error) {
    console.warn('[ProjectEditor] Failed to flush pending draft synchronously:', error);
  }
}

function flushPendingProjectEditorDraftForTermination(signal: NodeJS.Signals): void {
  if (handledTerminationSignal) return;
  handledTerminationSignal = true;
  isQuitting = true;
  logDevLifecycle('process.signal', { signal });
  flushPendingProjectEditorDraftSync();
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  if (latestUiResumeState) {
    saveUiResumeState(latestUiResumeState);
  }
  try {
    devFileWatcher?.close();
  } catch {
    // ignore cleanup failures during termination
  }
  devFileWatcher = null;
  disposeBrowserIpc();
  cleanup();
  process.exit(0);
}

process.once('SIGINT', flushPendingProjectEditorDraftForTermination);
process.once('SIGTERM', flushPendingProjectEditorDraftForTermination);

const RELEASES_URL = 'https://github.com/DylanDDeng/bubble-cowork/releases';
const PROJECT_EDITOR_FLUSH_REQUEST_CHANNEL = 'project-editor-flush-request';
const PROJECT_EDITOR_FLUSH_RESPONSE_CHANNEL = 'project-editor-flush-response';

type ProjectEditorFlushResponse = {
  requestId?: string;
  ok?: boolean;
  message?: string;
};

function requestProjectEditorFlush(
  win: BrowserWindow,
  timeoutMs = 5000
): Promise<{ ok: boolean; message?: string }> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return Promise.resolve({ ok: true });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      ipcMain.removeListener(PROJECT_EDITOR_FLUSH_RESPONSE_CHANNEL, handleResponse);
      resolve(result);
    };
    const handleResponse = (_event: Electron.IpcMainEvent, response: ProjectEditorFlushResponse) => {
      if (!response || response.requestId !== requestId) return;
      finish({
        ok: response.ok !== false,
        message: response.message,
      });
    };
    const timeoutId = setTimeout(() => {
      finish({ ok: false, message: 'Timed out while saving the project editor before closing.' });
    }, timeoutMs);

    ipcMain.on(PROJECT_EDITOR_FLUSH_RESPONSE_CHANNEL, handleResponse);

    try {
      win.webContents.send(PROJECT_EDITOR_FLUSH_REQUEST_CHANNEL, { requestId });
    } catch (error) {
      finish({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function getMainWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#111214' : '#ffffff';
}

function getWindowShellState(win: BrowserWindow): { rounded: boolean } {
  return {
    rounded:
      process.platform === 'darwin' &&
      !win.isMaximized() &&
      !win.isFullScreen() &&
      !win.isSimpleFullScreen(),
  };
}

function emitWindowShellState(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send('window-shell-state', getWindowShellState(win));
}

function registerWindowShellState(win: BrowserWindow): void {
  const emit = () => emitWindowShellState(win);

  win.on('maximize', emit);
  win.on('unmaximize', emit);
  win.on('enter-full-screen', emit);
  win.on('leave-full-screen', emit);
  win.webContents.on('did-finish-load', emit);
}

function logDevLifecycle(event: string, details?: unknown): void {
  if (!isDev()) {
    return;
  }

  if (details === undefined) {
    console.log(`[Dev Lifecycle] ${event}`);
    return;
  }

  console.log(`[Dev Lifecycle] ${event}`, details);
}

function shouldAutoOpenDevTools(): boolean {
  return process.env.AEGIS_OPEN_DEVTOOLS === '1';
}

function stripSimpleHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeReleaseNotes(
  releaseNotes: unknown
): string | null {
  if (typeof releaseNotes === 'string') {
    const normalized = stripSimpleHtml(releaseNotes).trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(releaseNotes)) {
    const sections = releaseNotes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const version = typeof (entry as { version?: unknown }).version === 'string'
          ? (entry as { version?: string }).version
          : null;
        const note = typeof (entry as { note?: unknown }).note === 'string'
          ? stripSimpleHtml((entry as { note?: string }).note || '')
          : '';

        if (!note.trim()) {
          return null;
        }

        return version ? `Version ${version}\n${note.trim()}` : note.trim();
      })
      .filter((value): value is string => Boolean(value && value.trim()));

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  return null;
}

function buildUpdateDetail(info: { releaseNotes?: unknown }): string {
  const notes = normalizeReleaseNotes(info.releaseNotes);
  if (!notes) {
    return 'This build uses manual updates. Open the GitHub Releases page to download the latest package.';
  }

  return `${notes}\n\nOpen the GitHub Releases page to download the latest package.`;
}

// 窗口状态持久化
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

function getWindowStateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function getUiResumeStateFile(): string {
  return path.join(app.getPath('userData'), 'ui-resume-state.json');
}

function loadUiResumeState(): import('../shared/types').UiResumeState | null {
  try {
    const file = getUiResumeStateFile();
    if (!fs.existsSync(file)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as import('../shared/types').UiResumeState;
  } catch {
    return null;
  }
}

function saveUiResumeState(state: import('../shared/types').UiResumeState): void {
  latestUiResumeState = state;
  try {
    fs.writeFileSync(getUiResumeStateFile(), JSON.stringify(state));
  } catch {
    // ignore
  }
}

function clearUiResumeState(): void {
  latestUiResumeState = null;
  try {
    const file = getUiResumeStateFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}

// Renderer key-value state persisted in userData instead of localStorage.
// localStorage is scoped to the page origin, which flips between the dev
// server (http://127.0.0.1:<port>) and the dist-react fallback (file://), so
// anything kept there — onboarding flag, draft sessions — silently "resets"
// whenever the origin changes. This store is origin-independent.
let rendererStateCache: Record<string, string> | null = null;
let rendererStateWriteTimer: NodeJS.Timeout | null = null;

function getRendererStateFile(): string {
  return path.join(app.getPath('userData'), 'renderer-state.json');
}

function loadRendererState(): Record<string, string> {
  if (rendererStateCache) {
    return rendererStateCache;
  }
  try {
    const file = getRendererStateFile();
    rendererStateCache = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>)
      : {};
  } catch {
    rendererStateCache = {};
  }
  return rendererStateCache;
}

function flushRendererState(): void {
  if (rendererStateWriteTimer) {
    clearTimeout(rendererStateWriteTimer);
    rendererStateWriteTimer = null;
  }
  if (!rendererStateCache) {
    return;
  }
  try {
    const file = getRendererStateFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rendererStateCache));
    fs.renameSync(tmp, file);
  } catch {
    // ignore — next write retries
  }
}

function scheduleRendererStateWrite(): void {
  if (rendererStateWriteTimer) {
    return;
  }
  rendererStateWriteTimer = setTimeout(() => {
    rendererStateWriteTimer = null;
    flushRendererState();
  }, 150);
}

function loadWindowState(): WindowState {
  try {
    const windowStateFile = getWindowStateFile();
    if (fs.existsSync(windowStateFile)) {
      return JSON.parse(fs.readFileSync(windowStateFile, 'utf-8'));
    }
  } catch {
    // 忽略错误，使用默认值
  }
  return { width: 1200, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const windowStateFile = getWindowStateFile();
    const state: WindowState = win.isMaximized()
      ? { ...loadWindowState(), isMaximized: true }
      : { ...win.getBounds(), isMaximized: false };
    fs.writeFileSync(windowStateFile, JSON.stringify(state));
  } catch {
    // 忽略保存错误
  }
}

async function waitForUiFile(filePath: string, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`UI file not found after ${timeoutMs}ms: ${filePath}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForDevServer(url: string, timeoutMs = 15000): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.ok) {
        clearTimeout(timeout);
        return true;
      }
    } catch {
      // keep waiting
    } finally {
      clearTimeout(timeout);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

async function loadDistFallbackUi(win: BrowserWindow): Promise<void> {
  try {
    const uiPath = getUIPath();
    await waitForUiFile(uiPath);
    if (win.isDestroyed()) {
      return;
    }
    await win.loadFile(uiPath);
    startDevFileReloadWatcher(win);
  } catch (fallbackError) {
    console.error('[Dev] Failed to load dist-react fallback UI:', fallbackError);
  }
}

async function loadDevUi(win: BrowserWindow): Promise<void> {
  const devServerReady = await waitForDevServer(DEV_SERVER_URL, 10000);

  if (!devServerReady) {
    console.warn('[Dev] Vite dev server not reachable in time, falling back to dist-react');
    await loadDistFallbackUi(win);
    return;
  }

  try {
    if (win.isDestroyed()) {
      return;
    }
    await win.loadURL(DEV_SERVER_URL);
  } catch (error) {
    console.warn('[Dev] Failed to load Vite dev server, falling back to dist-react:', error);
    await loadDistFallbackUi(win);
  }
}

function startDevFileReloadWatcher(win: BrowserWindow): void {
  if (devFileWatcher) {
    return;
  }

  const distDir = path.join(app.getAppPath(), 'dist-react');
  if (!fs.existsSync(distDir)) {
    return;
  }

  let reloadTimer: NodeJS.Timeout | null = null;

  try {
    devFileWatcher = fs.watch(distDir, { recursive: true }, () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      reloadTimer = setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.reloadIgnoringCache();
        }
      }, 150);
    });
  } catch (error) {
    console.warn('[Dev] Failed to watch dist-react for reload:', error);
  }
}

function createWindow(): void {
  const windowState = loadWindowState();

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 800,
    minHeight: 600,
    title: 'Aegis',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 15 },
    ...(process.platform === 'darwin' ? { roundedCorners: true } : {}),
    backgroundColor: getMainWindowBackgroundColor(),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      sandbox: false, // required by better-sqlite3
      // Keep debounce timers running in the background so editor autosave
      // still fires when the user switches away and immediately quits.
      backgroundThrottling: false,
    },
  });

  // 恢复最大化状态
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // 设置 IPC 处理器
  setupIPCHandlers(mainWindow);
  registerBrowserIpc(mainWindow);
  registerWindowShellState(mainWindow);

  // 后台预热 Claude 运行时状态缓存，避免首次发消息时等待 1-5 秒
  import('./libs/claude-runtime-status.js').then((m) => m.prefetchClaudeRuntimeStatus());

  if (isDev()) {
    const webContents = mainWindow.webContents;
    webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[Dev] Preload error:', preloadPath, error);
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return;
      }
      console.error('[Dev] Renderer load failed:', {
        errorCode,
        errorDescription,
        validatedURL,
      });
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      void loadDistFallbackUi(mainWindow);
    });
    webContents.on('render-process-gone', (_event, details) => {
      console.error('[Dev] Renderer process gone:', details);
    });
    webContents.on('unresponsive', () => {
      logDevLifecycle('webContents.unresponsive');
    });
    webContents.on('responsive', () => {
      logDevLifecycle('webContents.responsive');
    });
  }

  // 加载页面
  if (isDev()) {
    void loadDevUi(mainWindow);
    if (shouldAutoOpenDevTools()) {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(getUIPath());
  }

  // 保存窗口状态
  mainWindow.on('close', (event) => {
    const win = mainWindow;
    logDevLifecycle('mainWindow.close', {
      isQuitting,
      visible: mainWindow?.isVisible() ?? false,
      destroyed: mainWindow?.isDestroyed() ?? false,
    });
    if (!win) {
      return;
    }

    saveWindowState(win);
    if (latestUiResumeState) {
      saveUiResumeState(latestUiResumeState);
    }

    if (allowCloseAfterProjectEditorFlush) {
      allowCloseAfterProjectEditorFlush = false;
      return;
    }

    // Write the mirrored draft before the async renderer flush. The second
    // allowed close must not flush again because the mirror may be stale after
    // the renderer has already saved newer content.
    flushPendingProjectEditorDraftSync();

    event.preventDefault();
    if (projectEditorCloseFlushInProgress) {
      return;
    }

    projectEditorCloseFlushInProgress = true;
    void (async () => {
      const flushResult = await requestProjectEditorFlush(win);
      projectEditorCloseFlushInProgress = false;

      if (!flushResult.ok) {
        console.warn('[ProjectEditor] Failed to flush before close:', flushResult.message);
      }

      if (win.isDestroyed()) {
        return;
      }

      saveWindowState(win);
      if (latestUiResumeState) {
        saveUiResumeState(latestUiResumeState);
      }

      if (process.platform === 'darwin' && !isQuitting) {
        win.hide();
        return;
      }

      // Windows/Linux 上关窗即退出（window-all-closed → app.quit），会杀掉所有
      // 后台 runner——决策点 11：首版仅 macOS 支持"关窗照跑"，非 macOS 在有
      // 任务运行时弹确认，避免静默丢工作。
      if (process.platform !== 'darwin' && !isQuitting) {
        const runningCount = countRunningSessionsSafe();
        if (runningCount > 0) {
          const choice = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Quit anyway', 'Keep running'],
            defaultId: 1,
            cancelId: 1,
            message: `${runningCount} agent run${runningCount > 1 ? 's are' : ' is'} still in progress.`,
            detail: 'Closing the window quits Aegis on this platform and stops all running agents.',
          });
          if (choice.response === 1) {
            return;
          }
        }
      }

      allowCloseAfterProjectEditorFlush = true;
      win.close();
    })();
  });

  mainWindow.on('closed', () => {
    logDevLifecycle('mainWindow.closed');
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  mainWindow.focus();
}

function broadcastUpdateStatus(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(
    'server-event',
    JSON.stringify({
      type: 'app.update',
      payload: latestUpdateStatus,
    } satisfies import('../shared/types').ServerEvent)
  );
}

function setupAutoUpdater(): void {
  if (!app.isPackaged || updaterInitialized) {
    return;
  }
  updaterInitialized = true;
  autoUpdater.autoDownload = false;

  autoUpdater.on('error', (error) => {
    const shouldNotify = pendingManualUpdateCheck;
    pendingManualUpdateCheck = false;
    if (!shouldNotify) {
      console.warn('[Updater] Background update check failed:', error);
      return;
    }
    dialog.showMessageBox({
      type: 'error',
      title: 'Update error',
      message: 'Failed to check for updates.',
      detail: error?.message || String(error),
    });
  });

  autoUpdater.on('update-available', async (info) => {
    const shouldNotify = pendingManualUpdateCheck;
    latestUpdateStatus = {
      available: true,
      version: info?.version || null,
      autoDetected: !pendingManualUpdateCheck || latestUpdateStatus.autoDetected,
    };
    broadcastUpdateStatus();
    pendingManualUpdateCheck = false;
    if (!shouldNotify) {
      return;
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `A new version${info?.version ? ` (${info.version})` : ''} is available.`,
      detail: buildUpdateDetail(info),
      buttons: ['Open Release Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      void shell.openExternal(RELEASES_URL);
    }
  });

  autoUpdater.on('update-not-available', () => {
    latestUpdateStatus = {
      available: false,
      version: null,
      autoDetected: false,
    };
    broadcastUpdateStatus();
    const shouldNotify = pendingManualUpdateCheck;
    pendingManualUpdateCheck = false;
    if (!shouldNotify) {
      return;
    }
    dialog.showMessageBox({
      type: 'info',
      title: 'Up to date',
      message: 'You are already using the latest version.',
    });
  });

  autoUpdater.on('update-downloaded', () => {
    void shell.openExternal(RELEASES_URL);
  });
}

function checkForUpdates(options?: { manual?: boolean }): void {
  if (!app.isPackaged) {
    pendingManualUpdateCheck = false;
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Updates are only available in the packaged app.',
    });
    return;
  }

  pendingManualUpdateCheck = options?.manual === true;
  autoUpdater.checkForUpdates();
}

function scheduleAutomaticUpdateCheck(): void {
  if (!app.isPackaged || updateCheckStarted) {
    return;
  }

  updateCheckStarted = true;
  setTimeout(() => {
    checkForUpdates({ manual: false });
  }, 8000);
}

function setupMenu(): void {
  const isMac = process.platform === 'darwin';
  const role = (
    value: Electron.MenuItemConstructorOptions['role']
  ): Electron.MenuItemConstructorOptions => ({ role: value });
  const separator = (): Electron.MenuItemConstructorOptions => ({ type: 'separator' });
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    const appSubmenu: Electron.MenuItemConstructorOptions[] = [
      role('about'),
      {
        label: 'Check for Updates...',
        click: () => checkForUpdates({ manual: true }),
      },
      separator(),
      role('services'),
      separator(),
      role('hide'),
      role('hideOthers'),
      role('unhide'),
      separator(),
      role('quit'),
    ];
    template.push({
      label: app.name,
      submenu: appSubmenu,
    });
  }

  const editSubmenu: Electron.MenuItemConstructorOptions[] = [
    role('undo'),
    role('redo'),
    separator(),
    role('cut'),
    role('copy'),
    role('paste'),
  ];
  if (isMac) {
    editSubmenu.push(role('pasteAndMatchStyle'), role('delete'), role('selectAll'));
  } else {
    editSubmenu.push(role('delete'), role('selectAll'));
  }

  template.push({
    label: 'Edit',
    submenu: editSubmenu,
  });

  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    role('reload'),
    role('forceReload'),
    role('toggleDevTools'),
    separator(),
    role('resetZoom'),
    role('zoomIn'),
    role('zoomOut'),
    separator(),
    role('togglefullscreen'),
  ];

  template.push({
    label: 'View',
    submenu: viewSubmenu,
  });

  const windowSubmenu: Electron.MenuItemConstructorOptions[] = [
    role('minimize'),
    role('zoom'),
  ];
  if (isMac) {
    windowSubmenu.push(separator(), role('front'), role('window'));
  } else {
    windowSubmenu.push(role('close'));
  }

  template.push({
    label: 'Window',
    submenu: windowSubmenu,
  });

  if (!isMac) {
    const helpSubmenu: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Check for Updates...',
        click: () => checkForUpdates({ manual: true }),
      },
    ];
    template.push({
      label: 'Help',
      submenu: helpSubmenu,
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 应用启动
app.whenReady().then(() => {
  // 生产环境设置 CSP；开发环境不限制（Vite HMR 需要 WebSocket 和 eval）
  if (!isDev()) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; frame-src 'self' blob: data:; object-src 'self' blob: data:; connect-src 'self'",
          ],
        },
      });
    });
  }

  latestUiResumeState = loadUiResumeState();
  setupMenu();
  setupAutoUpdater();
  ipcMainHandle('check-for-updates', async () => {
    checkForUpdates({ manual: true });
    return { ok: true };
  });
  ipcMainHandle('get-update-status', async () => {
    return latestUpdateStatus;
  });
  ipcMainHandle('get-ui-resume-state', async () => {
    return latestUiResumeState;
  });
  ipcMain.on('get-ui-resume-state-sync', (event) => {
    event.returnValue = latestUiResumeState;
  });
  ipcMainHandle('save-ui-resume-state', async (_event, state: import('../shared/types').UiResumeState) => {
    saveUiResumeState(state);
    return { ok: true };
  });
  ipcMain.on('save-ui-resume-state-sync', (event, state: import('../shared/types').UiResumeState) => {
    saveUiResumeState(state);
    event.returnValue = { ok: true };
  });
  // Origin-independent renderer state. The preload snapshots the full map
  // synchronously at page load (mirrors how localStorage hydrates), then
  // forwards writes here.
  ipcMain.on('renderer-state:get-all-sync', (event) => {
    event.returnValue = loadRendererState();
  });
  ipcMain.on('renderer-state:set', (_event, key: string, value: string) => {
    if (typeof key !== 'string' || typeof value !== 'string') return;
    loadRendererState()[key] = value;
    scheduleRendererStateWrite();
  });
  ipcMain.on('renderer-state:remove', (_event, key: string) => {
    if (typeof key !== 'string') return;
    delete loadRendererState()[key];
    scheduleRendererStateWrite();
  });
  // Keep the pending editor draft mirrored in the main process. Normal edits
  // use async IPC; blur/unload paths use sync IPC before the renderer freezes.
  ipcMain.on('project-editor-draft-update', (_event, draft: PendingProjectEditorDraft | null) => {
    setPendingProjectEditorDraft(draft);
  });
  ipcMain.on('project-editor-draft-update-sync', (event, draft: PendingProjectEditorDraft | null) => {
    setPendingProjectEditorDraft(draft);
    event.returnValue = { ok: true };
  });
  // Called from beforeunload/pagehide to synchronously finish the file write
  // without depending on close/before-quit ordering or in-flight async IPC.
  ipcMain.on('write-project-text-file-sync', (event, draft: PendingProjectEditorDraft | null) => {
    setPendingProjectEditorDraft(draft);
    flushPendingProjectEditorDraftSync();
    event.returnValue = { ok: true };
  });
  ipcMainHandle('get-app-version', async () => {
    return app.getVersion();
  });
  ipcMainHandle('get-window-shell-state', async () => {
    return mainWindow ? getWindowShellState(mainWindow) : { rounded: process.platform === 'darwin' };
  });
  ipcMainHandle('set-theme', async (_event, theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme;
    mainWindow?.setBackgroundColor(getMainWindowBackgroundColor());
    browserManager.applyThemeBackground();
    return { ok: true };
  });
  createWindow();
  scheduleAutomaticUpdateCheck();

  app.on('activate', () => {
    logDevLifecycle('app.activate');
    showMainWindow();
  });
});

// 窗口全部关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  logDevLifecycle('app.window-all-closed', { platform: process.platform });
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit();
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  logDevLifecycle('app.before-quit');
  isQuitting = true;
  // Persist unsaved editor content before cleanup tears down shared resources.
  flushPendingProjectEditorDraftSync();
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow);
  }
  if (latestUiResumeState) {
    saveUiResumeState(latestUiResumeState);
  }
  flushRendererState();
  devFileWatcher?.close();
  devFileWatcher = null;
  disposeBrowserIpc();
  cleanup();
});

app.on('will-quit', () => {
  logDevLifecycle('app.will-quit');
  // Last fallback for quit paths that bypass before-quit.
  flushPendingProjectEditorDraftSync();
  flushRendererState();
});

app.on('child-process-gone', (_event, details) => {
  console.error('[Dev] Child process gone:', details);
});

app.on('quit', (_event, exitCode) => {
  logDevLifecycle('app.quit', { exitCode });
});

process.on('uncaughtException', (error) => {
  console.error('[Dev Lifecycle] uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Dev Lifecycle] unhandledRejection', reason);
});
