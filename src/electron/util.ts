import { app, ipcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

// 判断是否为开发环境
export function isDev(): boolean {
  return !app?.isPackaged;
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
  return `http://127.0.0.1:${port}`;
}

export const DEV_SERVER_URL = getDevServerUrl();

type IpcSenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

function isPathWithinRoot(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

function isTrustedRendererUrl(frameUrl: string): boolean {
  try {
    const parsed = new URL(frameUrl);
    const devUrl = new URL(getDevServerUrl());
    if (isDev() && parsed.protocol === devUrl.protocol && parsed.origin === devUrl.origin) {
      return true;
    }

    if (parsed.protocol !== 'file:') {
      return false;
    }
    const uiRoot = path.resolve(app.getAppPath(), 'dist-react');
    return isPathWithinRoot(uiRoot, path.resolve(fileURLToPath(parsed)));
  } catch {
    return false;
  }
}

export function assertTrustedIpcSender(event: IpcSenderEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error('Unauthorized IPC sender frame');
  }
  if (!isTrustedRendererUrl(frame.url)) {
    throw new Error(`Unauthorized IPC sender URL: ${frame.url}`);
  }
}

export function normalizeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(String(url ?? '').trim());
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// IPC invoke 包装器（带主 frame 与来源校验）
export function ipcMainHandle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T
): void {
  // 先移除旧的 handler（避免 macOS 上窗口重新激活时重复注册）
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event);
    return handler(event, ...args);
  });
}

export function ipcMainOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void | Promise<void>
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event);
      void Promise.resolve(listener(event, ...args)).catch((error) => {
        console.error(`[IPC] ${channel} failed:`, error);
      });
    } catch (error) {
      console.warn(`[IPC] Blocked ${channel}:`, error);
      event.returnValue = { ok: false, message: 'Unauthorized IPC sender.' };
    }
  });
}
