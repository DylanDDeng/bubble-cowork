import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { setupIPCHandlers, cleanup } from './ipc-handlers';
import { isDev, getPreloadPath, getUIPath, DEV_SERVER_URL } from './util';

let mainWindow: BrowserWindow | null = null;

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

// 应用启动
app.whenReady().then(() => {
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
