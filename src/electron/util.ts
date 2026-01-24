import { app, ipcMain, IpcMainInvokeEvent } from 'electron';
import path from 'path';

// 判断是否为开发环境
export function isDev(): boolean {
  return !app.isPackaged;
}

// 获取 Preload 脚本路径
export function getPreloadPath(): string {
  if (isDev()) {
    return path.join(__dirname, 'preload.cjs');
  }
  return path.join(process.resourcesPath, 'preload.cjs');
}

// 获取 UI 入口文件路径（生产环境）
export function getUIPath(): string {
  return path.join(app.getAppPath(), 'dist-react', 'index.html');
}

// 开发服务器 URL
export function getDevServerUrl(): string {
  const explicit = process.env.DEV_SERVER_URL || process.env.VITE_DEV_SERVER_URL;
  if (explicit) {
    return explicit;
  }
  const port = process.env.PORT || '10087';
  return `http://localhost:${port}`;
}

export const DEV_SERVER_URL = getDevServerUrl();

// IPC invoke 包装器（带 frame 校验）
export function ipcMainHandle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T
): void {
  // 先移除旧的 handler（避免 macOS 上窗口重新激活时重复注册）
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    // Frame 校验
    const frame = event.senderFrame;
    if (!frame) {
      throw new Error('Invalid sender frame');
    }

    const frameUrl = frame.url;
    const isValidDev = frameUrl.startsWith(getDevServerUrl());
    const isValidFileUi = frameUrl.startsWith('file://') && frameUrl.includes('dist-react');

    if (!isValidDev && !isValidFileUi) {
      throw new Error(`Unauthorized frame: ${frameUrl}`);
    }

    return handler(event, ...args);
  });
}
