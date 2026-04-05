import { app, BrowserWindow, Menu, dialog, shell, ipcMain, session } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { setupIPCHandlers, cleanup } from './ipc-handlers';
import { isDev, getPreloadPath, getUIPath, DEV_SERVER_URL, ipcMainHandle } from './util';

// 修复打包后的环境变量问题（macOS/Linux GUI 应用无法继承 shell 的环境变量）
function fixEnvironment(): void {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      // 从用户的默认 shell 获取完整环境变量
      const shell = process.env.SHELL || '/bin/zsh';
      const envOutput = execSync(`${shell} -lc 'env'`, {
        encoding: 'utf-8',
        timeout: 5000,
      });

      // 解析并注入关键环境变量
      for (const line of envOutput.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.substring(0, idx);
          const value = line.substring(idx + 1);
          // 注入关键变量
          if (['PATH', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY', 'HOME', 'USER', 'LANG'].includes(key)) {
            process.env[key] = value;
          }
        }
      }

      console.log('[Environment] Loaded from shell:', {
        hasPath: !!process.env.PATH,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        apiKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 15),
      });
    } catch (error) {
      console.warn('[Environment] Failed to load from shell:', error);
      // 如果失败，添加常见的 node 安装路径
      const commonPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
        `${process.env.HOME}/.nvm/versions/node/current/bin`,
        `${process.env.HOME}/.volta/bin`,
        `${process.env.HOME}/.local/bin`,
      ];
      process.env.PATH = `${commonPaths.join(':')}:${process.env.PATH || ''}`;
    }
  }
}

// 在应用启动前修复环境变量
fixEnvironment();

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
let latestUiResumeState: import('../shared/types').UiResumeState | null = null;
let isQuitting = false;
const RELEASES_URL = 'https://github.com/DylanDDeng/bubble-cowork/releases';

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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      sandbox: false, // better-sqlite3 需要
    },
  });

  // 恢复最大化状态
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // 设置 IPC 处理器
  setupIPCHandlers(mainWindow);

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
    if (!mainWindow) {
      return;
    }

    saveWindowState(mainWindow);
    if (latestUiResumeState) {
      saveUiResumeState(latestUiResumeState);
    }

    if (process.platform === 'darwin' && !isQuitting && !isDev()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
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

function setupAutoUpdater(): void {
  if (!app.isPackaged || updaterInitialized) {
    return;
  }
  updaterInitialized = true;
  autoUpdater.autoDownload = false;

  autoUpdater.on('error', (error) => {
    dialog.showMessageBox({
      type: 'error',
      title: 'Update error',
      message: 'Failed to check for updates.',
      detail: error?.message || String(error),
    });
  });

  autoUpdater.on('update-available', async (info) => {
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

function checkForUpdates(): void {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Updates',
      message: 'Updates are only available in the packaged app.',
    });
    return;
  }
  autoUpdater.checkForUpdates();
}

function scheduleAutomaticUpdateCheck(): void {
  if (!app.isPackaged || updateCheckStarted) {
    return;
  }

  updateCheckStarted = true;
  setTimeout(() => {
    checkForUpdates();
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
        click: () => checkForUpdates(),
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
        click: () => checkForUpdates(),
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
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' blob: data:; object-src 'self' blob: data:; connect-src 'self'",
          ],
        },
      });
    });
  }

  clearUiResumeState();
  setupMenu();
  setupAutoUpdater();
  ipcMainHandle('check-for-updates', async () => {
    checkForUpdates();
    return { ok: true };
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
  ipcMainHandle('get-app-version', async () => {
    return app.getVersion();
  });
  createWindow();
  scheduleAutomaticUpdateCheck();

  app.on('activate', () => {
    showMainWindow();
  });
});

// 窗口全部关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isDev()) {
    app.quit();
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  isQuitting = true;
  clearUiResumeState();
  devFileWatcher?.close();
  devFileWatcher = null;
  cleanup();
});
