import { BrowserWindow, type BrowserWindowConstructorOptions, shell } from 'electron';
import {
  COMPUTER_USE_PREVIEW_HASH,
  appendComputerUseLiveFrame,
  computerUsePreviewWindowPolicy,
  isComputerUseArtifactSha256,
  mergeComputerUseLiveFrame,
  type ComputerUseGrantView,
  type ComputerUseLiveFrame,
  type ComputerUsePreviewOpenInput,
  type ComputerUsePreviewSnapshot,
} from '../../shared/computer-use';
import { DEV_SERVER_URL, getPreloadPath, getUIPath, isDev } from '../util';

type SessionCache = {
  live: ComputerUseLiveFrame | null;
  frames: ComputerUseLiveFrame[];
  grants: ComputerUseGrantView[];
};

let hostWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let previewSessionId: string | null = null;
let parkedSha256: string | null = null;
const sessionCache = new Map<string, SessionCache>();

export function attachComputerUsePreviewHost(win: BrowserWindow): void {
  hostWindow = win;
  win.on('closed', () => {
    if (hostWindow === win) {
      closeComputerUsePreviewWindow();
      hostWindow = null;
    }
  });
}

export function buildComputerUsePreviewWindowOptions(
  parent: BrowserWindow
): BrowserWindowConstructorOptions {
  const policy = computerUsePreviewWindowPolicy();
  return {
    parent,
    modal: policy.modal,
    show: false,
    width: 420,
    height: 560,
    minWidth: 320,
    minHeight: 280,
    title: 'Computer Use',
    alwaysOnTop: policy.alwaysOnTop,
    fullscreenable: policy.fullscreenable,
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
}

export function rememberComputerUseLive(sessionId: string, frame: ComputerUseLiveFrame): void {
  const current = sessionCache.get(sessionId) || { live: null, frames: [], grants: [] };
  const next: SessionCache = {
    live: mergeComputerUseLiveFrame(current.live, frame),
    frames: appendComputerUseLiveFrame(current.frames, frame),
    grants: current.grants,
  };
  sessionCache.set(sessionId, next);
  if (previewSessionId === sessionId) pushPreviewSnapshot();
}

export function rememberComputerUseGrants(sessionId: string, grants: ComputerUseGrantView[]): void {
  const current = sessionCache.get(sessionId) || { live: null, frames: [], grants: [] };
  sessionCache.set(sessionId, { ...current, grants });
  if (previewSessionId === sessionId) pushPreviewSnapshot();
}

export function forgetComputerUseSession(sessionId: string): void {
  sessionCache.delete(sessionId);
  if (previewSessionId === sessionId) closeComputerUsePreviewWindow();
}

export function getComputerUsePreviewSnapshot(): ComputerUsePreviewSnapshot | null {
  if (!previewSessionId) return null;
  const cached = sessionCache.get(previewSessionId) || { live: null, frames: [], grants: [] };
  return {
    sessionId: previewSessionId,
    parkedSha256,
    live: cached.live,
    frames: cached.frames,
    grants: cached.grants,
  };
}

export function isComputerUsePreviewOpen(): boolean {
  return Boolean(previewWindow && !previewWindow.isDestroyed());
}

export async function openComputerUsePreviewWindow(
  input: ComputerUsePreviewOpenInput
): Promise<{ ok: boolean; open: boolean; sessionId: string; message?: string }> {
  const sessionId = sanitizeSessionId(input.sessionId);
  if (!sessionId) return { ok: false, open: false, sessionId: '', message: 'Missing session.' };
  const parent = hostWindow;
  if (!parent || parent.isDestroyed()) {
    return { ok: false, open: false, sessionId, message: 'Main window is gone.' };
  }

  seedSessionCache(sessionId, input);
  previewSessionId = sessionId;
  parkedSha256 = sanitizeSha256(input.parkedSha256);

  if (previewWindow && !previewWindow.isDestroyed()) {
    pushPreviewSnapshot();
    notifyHostPreview(true);
    if (previewWindow.isMinimized()) previewWindow.restore();
    previewWindow.show();
    previewWindow.focus();
    return { ok: true, open: true, sessionId };
  }

  const win = new BrowserWindow(buildComputerUsePreviewWindowOptions(parent));
  previewWindow = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    positionBesideParent(win, parent);
    win.show();
    pushPreviewSnapshot();
  });
  win.on('closed', () => {
    if (previewWindow === win) {
      previewWindow = null;
      previewSessionId = null;
      parkedSha256 = null;
      notifyHostPreview(false);
    }
  });

  await loadComputerUsePreviewUi(win);
  notifyHostPreview(true);
  return { ok: true, open: true, sessionId };
}

export function closeComputerUsePreviewWindow(): void {
  const win = previewWindow;
  previewWindow = null;
  previewSessionId = null;
  parkedSha256 = null;
  if (win && !win.isDestroyed()) win.close();
  notifyHostPreview(false);
}

export function stopComputerUsePreviewIfSession(sessionId: string): void {
  if (previewSessionId === sessionId) closeComputerUsePreviewWindow();
}

export function setComputerUsePreviewParked(sha256: string | null): void {
  parkedSha256 = sanitizeSha256(sha256);
  pushPreviewSnapshot();
}

async function loadComputerUsePreviewUi(win: BrowserWindow): Promise<void> {
  if (isDev()) {
    try {
      const url = `${DEV_SERVER_URL.replace(/\/$/, '')}/#${COMPUTER_USE_PREVIEW_HASH}`;
      await win.loadURL(url);
      return;
    } catch {
      // fall through to packaged UI
    }
  }
  await win.loadFile(getUIPath(), { hash: COMPUTER_USE_PREVIEW_HASH });
}

function seedSessionCache(sessionId: string, input: ComputerUsePreviewOpenInput): void {
  const current = sessionCache.get(sessionId) || { live: null, frames: [], grants: [] };
  const frames = Array.isArray(input.frames)
    ? input.frames.map((frame) => sanitizeFrame(sessionId, frame)).filter((frame): frame is ComputerUseLiveFrame => Boolean(frame))
    : current.frames;
  const live = input.live ? sanitizeFrame(sessionId, input.live) : current.live;
  const grants = Array.isArray(input.grants) ? input.grants : current.grants;
  sessionCache.set(sessionId, {
    live: live || current.live,
    frames: frames.length > 0 ? frames.slice(-12) : current.frames,
    grants,
  });
}

function sanitizeFrame(sessionId: string, frame: ComputerUseLiveFrame): ComputerUseLiveFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const media =
    frame.media &&
    frame.media.sessionId === sessionId &&
    isComputerUseArtifactSha256(frame.media.sha256)
      ? {
          sessionId,
          sha256: frame.media.sha256.trim().toLowerCase(),
          mimeType: typeof frame.media.mimeType === 'string' ? frame.media.mimeType : 'image/png',
          sizeBytes: Number(frame.media.sizeBytes) || 0,
        }
      : null;
  return {
    threadId: String(frame.threadId || ''),
    toolUseId: String(frame.toolUseId || ''),
    label: String(frame.label || 'Computer Use'),
    app: frame.app ? String(frame.app) : null,
    tool: frame.tool ? String(frame.tool) : null,
    mutating: Boolean(frame.mutating),
    media,
    hasFreshMedia: Boolean(frame.hasFreshMedia && media),
    at: Number(frame.at) || Date.now(),
  };
}

function sanitizeSessionId(value: string | null | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  return raw;
}

function sanitizeSha256(value: string | null | undefined): string | null {
  return isComputerUseArtifactSha256(value) ? String(value).trim().toLowerCase() : null;
}

function pushPreviewSnapshot(): void {
  const win = previewWindow;
  const snapshot = getComputerUsePreviewSnapshot();
  if (!win || win.isDestroyed() || !snapshot || win.webContents.isDestroyed()) return;
  win.webContents.send('computer-use-preview-state', JSON.stringify(snapshot));
}

function notifyHostPreview(open: boolean): void {
  const host = hostWindow;
  if (!host || host.isDestroyed() || host.webContents.isDestroyed()) return;
  const sessionId = previewSessionId || '';
  host.webContents.send(
    'server-event',
    JSON.stringify({
      type: 'computerUse.preview',
      payload: { sessionId, open },
    })
  );
}

function positionBesideParent(win: BrowserWindow, parent: BrowserWindow): void {
  const bounds = parent.getBounds();
  win.setPosition(Math.round(bounds.x + bounds.width - 48), Math.round(bounds.y + 72));
}
