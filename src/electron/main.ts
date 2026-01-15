import { app, BrowserWindow } from 'electron';
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
