import { app, BrowserWindow, Menu, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { setupIPCHandlers, cleanup } from './ipc-handlers';
import { isDev, getPreloadPath, getUIPath, DEV_SERVER_URL } from './util';

// 修复打包后的环境变量问题（macOS/Linux GUI 应用无法继承 shell 的环境变量）
function fixEnvironment(): void {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      // 从用户的默认 shell 获取完整环境变量
      const shell = process.env.SHELL || '/bin/zsh';
      const envOutput = execSync(`${shell} -ilc 'env'`, {
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
          if (['PATH', 'ANTHROPIC_API_KEY', 'HOME', 'USER', 'LANG'].includes(key)) {
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

let mainWindow: BrowserWindow | null = null;
let updaterInitialized = false;

// 窗口状态持久化
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(WINDOW_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
    }
  } catch {
    // 忽略错误，使用默认值
  }
  return { width: 1200, height: 800 };
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const state: WindowState = win.isMaximized()
      ? { ...loadWindowState(), isMaximized: true }
      : { ...win.getBounds(), isMaximized: false };
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state));
  } catch {
    // 忽略保存错误
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
      sandbox: false, // better-sqlite3 需要
    },
  });

  // 恢复最大化状态
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // 设置 IPC 处理器
  setupIPCHandlers(mainWindow);

  // 加载页面
  if (isDev()) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(getUIPath());
  }

  // 保存窗口状态
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

  autoUpdater.on('update-available', async () => {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: 'A new version is available. Do you want to download it now?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on('update-not-available', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Up to date',
      message: 'You are already using the latest version.',
    });
  });

  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'The update has been downloaded. Restart to install now?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
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

function setupMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
        : [{ role: 'delete' }, { role: 'selectAll' }]),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? [{ type: 'separator' }, { role: 'front' }, { role: 'window' }]
        : [{ role: 'close' }]),
    ],
  });

  if (!isMac) {
    template.push({
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates(),
        },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 应用启动
app.whenReady().then(() => {
  setupMenu();
  setupAutoUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 窗口全部关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前清理
app.on('before-quit', () => {
  cleanup();
});
