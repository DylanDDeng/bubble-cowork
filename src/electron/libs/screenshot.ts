import { app, BrowserWindow, clipboard, desktopCapturer, dialog, nativeImage, screen, shell, systemPreferences } from 'electron';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  SCREENSHOT_EDITOR_HASH,
  screenshotFileName,
  screenshotCaptureRect,
  type ScreenshotRect,
  type ScreenshotCaptureInfo,
  type ScreenshotCaptureResult,
  type ScreenshotEditorPayload,
  type ScreenshotExportAction,
  type ScreenshotExportResult,
  type ScreenshotMode,
} from '../../shared/screenshot';
import { importAttachmentBytes } from './file-attachments';
import { DEV_SERVER_URL, getPreloadPath, getUIPath, isDev } from '../util';

const SCREENCAPTURE = '/usr/sbin/screencapture';
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
// Long enough for the hide animation, so Aegis never appears in its own shot.
const HIDE_SETTLE_MS = 220;

let hostWindow: BrowserWindow | null = null;
let editorWindow: BrowserWindow | null = null;
let current: { info: ScreenshotCaptureInfo; path: string } | null = null;
let capturing = false;
let selection: { id: string; host: BrowserWindow; finish: (rect: ScreenshotRect | null) => void } | null = null;

export function completeScreenshotSelection(sender: Electron.WebContents, id: string, rect: ScreenshotRect | null): void {
  if (selection?.id === id && selection.host.webContents === sender) selection.finish(rect);
}

function selectAppArea(host: BrowserWindow): Promise<ScreenshotRect | null> {
  const contents = host.webContents;
  return new Promise((resolve) => {
    const id = randomUUID();
    const cancel = () => finish(null);
    const finish = (rect: ScreenshotRect | null) => {
      if (selection?.id !== id) return;
      selection = null;
      host.removeListener('closed', cancel);
      contents.removeListener('did-start-navigation', cancel);
      contents.removeListener('render-process-gone', cancel);
      resolve(rect);
    };
    selection = { id, host, finish };
    host.once('closed', cancel);
    contents.once('did-start-navigation', cancel);
    contents.once('render-process-gone', cancel);
    contents.send('screenshot-select-area', id);
  });
}

export function attachScreenshotHost(win: BrowserWindow): void {
  hostWindow = win;
  win.on('closed', () => {
    if (hostWindow === win) {
      closeScreenshotEditor();
      hostWindow = null;
    }
  });
}

export function isScreenshotEditorSender(sender: Electron.WebContents): boolean {
  return Boolean(editorWindow && !editorWindow.isDestroyed() && editorWindow.webContents === sender);
}

function captureDirectory(): string {
  return join(app.getPath('userData'), 'screenshots');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenRecordingGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.getMediaAccessStatus('screen') === 'granted';
}

function runScreencapture(mode: 'area' | 'window', target: string): Promise<void> {
  // -i interactive (Space toggles area/window), -W start in window mode,
  // -o drop the window shadow (the editor adds its own), -x no sound.
  const args = ['-i', '-o', '-x', ...(mode === 'window' ? ['-W'] : []), '-t', 'png', target];
  return new Promise((resolve, reject) => {
    execFile(SCREENCAPTURE, args, { timeout: 10 * 60 * 1000 }, (error) => (error ? reject(error) : resolve()));
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

async function captureSystem(mode: 'area' | 'window', target: string): Promise<boolean> {
  const wasVisible = Boolean(hostWindow && !hostWindow.isDestroyed() && hostWindow.isVisible());
  app.hide();
  await delay(HIDE_SETTLE_MS);
  try {
    await runScreencapture(mode, target);
  } finally {
    app.show();
    if (wasVisible && hostWindow && !hostWindow.isDestroyed()) hostWindow.showInactive();
  }
  // Esc leaves no file behind.
  return (await fileSize(target)) > 0;
}

async function captureAppWindow(target: string): Promise<boolean> {
  const host = hostWindow;
  if (!host || host.isDestroyed()) return false;
  focusHost();
  // Let the menu/permission dialog close before presenting the selection layer.
  await delay(HIDE_SETTLE_MS);
  if (host.isDestroyed()) return false;
  const selected = await selectAppArea(host);
  if (host.isDestroyed()) return false;
  const rect = screenshotCaptureRect(selected, host.getContentBounds(), host.webContents.getZoomFactor());
  if (!rect) return false;
  // The renderer removes its selection layer before replying. Wait for paint
  // so neither the dimming mask nor the selection border enters the capture.
  await delay(80);
  if (host.isDestroyed()) return false;
  const image = await host.webContents.capturePage(rect);
  if (image.isEmpty()) return false;
  await fs.writeFile(target, image.toPNG());
  return true;
}

export async function captureScreenshot(mode: ScreenshotMode): Promise<ScreenshotCaptureResult> {
  if (!['area', 'window', 'app'].includes(mode)) return { status: 'error', message: 'Unknown capture mode.' };
  if (capturing) return { status: 'busy' };
  if (mode !== 'app') {
    if (process.platform !== 'darwin') {
      return { status: 'error', message: 'Area and window capture are only available on macOS.' };
    }
    if (!screenRecordingGranted()) return { status: 'permission-required' };
  }
  capturing = true;
  const id = randomUUID();
  const target = join(captureDirectory(), `${id}.png`);
  try {
    await fs.mkdir(captureDirectory(), { recursive: true });
    const scaleFactor = mode === 'app' && hostWindow && !hostWindow.isDestroyed()
      ? screen.getDisplayMatching(hostWindow.getBounds()).scaleFactor
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
    const captured = mode === 'app' ? await captureAppWindow(target) : await captureSystem(mode, target);
    if (!captured) {
      await fs.rm(target, { force: true });
      return { status: 'cancelled' };
    }
    const size = nativeImage.createFromPath(target).getSize();
    if (!size.width || !size.height) {
      await fs.rm(target, { force: true });
      return { status: 'error', message: 'The capture could not be read.' };
    }
    const previous = current;
    current = {
      path: target,
      info: { id, mode, width: size.width, height: size.height, scaleFactor: scaleFactor || 1, capturedAt: Date.now() },
    };
    // Keep only the latest raw capture on disk ("Open last screenshot").
    if (previous && previous.path !== target) void fs.rm(previous.path, { force: true });
    await openScreenshotEditor();
    return { status: 'opened' };
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    return { status: 'error', message: error instanceof Error ? error.message : 'Screenshot failed.' };
  } finally {
    capturing = false;
  }
}

export async function openLastScreenshot(): Promise<ScreenshotCaptureResult> {
  if (!current || (await fileSize(current.path)) === 0) {
    return { status: 'error', message: 'No screenshot yet.' };
  }
  await openScreenshotEditor();
  return { status: 'opened' };
}

/**
 * macOS only lists an app under Screen Recording after it has asked once, so
 * touch desktopCapturer (which registers + prompts) before opening Settings.
 */
export async function requestScreenRecordingPermission(): Promise<void> {
  if (process.platform !== 'darwin') return;
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

export async function loadScreenshotEditorPayload(): Promise<ScreenshotEditorPayload | null> {
  if (!current) return null;
  try {
    const data = await fs.readFile(current.path);
    return { info: current.info, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } catch {
    return null;
  }
}

async function openScreenshotEditor(): Promise<void> {
  const existing = editorWindow;
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('screenshot-editor-updated');
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(1180, Math.round(display.workArea.width * 0.9));
  const height = Math.min(760, Math.round(display.workArea.height * 0.9));
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
    minWidth: 760,
    minHeight: 480,
    title: 'Screenshot',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 15 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  editorWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (editorWindow === win) editorWindow = null;
  });
  if (isDev()) {
    try {
      await win.loadURL(`${DEV_SERVER_URL.replace(/\/$/, '')}/#${SCREENSHOT_EDITOR_HASH}`);
      return;
    } catch {
      // fall through to packaged UI
    }
  }
  await win.loadFile(getUIPath(), { hash: SCREENSHOT_EDITOR_HASH });
}

export function closeScreenshotEditor(): void {
  const win = editorWindow;
  editorWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

export async function retakeScreenshot(): Promise<ScreenshotCaptureResult> {
  const mode = current?.info.mode ?? 'area';
  closeScreenshotEditor();
  return captureScreenshot(mode);
}

function focusHost(): void {
  const host = hostWindow;
  if (!host || host.isDestroyed()) return;
  if (host.isMinimized()) host.restore();
  host.show();
  host.focus();
}

export async function exportScreenshot(
  action: ScreenshotExportAction,
  data: Uint8Array,
  suggestedName?: string
): Promise<ScreenshotExportResult> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_EXPORT_BYTES) {
    return { ok: false, message: 'The screenshot is empty or too large.' };
  }
  const name = typeof suggestedName === 'string' && /^[\w .,()-]{1,120}\.png$/.test(suggestedName)
    ? suggestedName
    : screenshotFileName(new Date());
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    if (action === 'copy') {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return { ok: false, message: 'The screenshot could not be encoded.' };
      clipboard.writeImage(image);
      return { ok: true };
    }
    if (action === 'save') {
      const parent = editorWindow && !editorWindow.isDestroyed() ? editorWindow : undefined;
      const options = {
        defaultPath: join(app.getPath('desktop'), name),
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { ok: false };
      await fs.writeFile(result.filePath, buffer);
      return { ok: true };
    }
    if (action === 'attach') {
      const host = hostWindow;
      if (!host || host.isDestroyed()) return { ok: false, message: 'The main window is not open.' };
      const attachment = await importAttachmentBytes(name, data);
      host.webContents.send('screenshot-attach', attachment);
      closeScreenshotEditor();
      focusHost();
      return { ok: true };
    }
    return { ok: false, message: 'Unknown export action.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Export failed.' };
  }
}
