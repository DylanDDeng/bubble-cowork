import { Notification, app } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { SessionRow } from '../types';

export interface NotificationSettings {
  enabled: boolean;
  // 仅在窗口失焦/隐藏时弹（前台工作不打扰）
  onlyWhenUnfocused: boolean;
  inputRequired: boolean;
  approvalRequired: boolean;
}

export type NotificationActivateTarget = { kind: 'session'; sessionId: string };

const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, onlyWhenUnfocused: true, inputRequired: true, approvalRequired: true };

let cachedSettings: NotificationSettings | null = null;
let isWindowFocused: () => boolean = () => false;
let onActivate: ((target: NotificationActivateTarget) => void) | null = null;

function settingsPath(): string {
  return join(app.getPath('userData'), 'notification-settings.json');
}

export function getNotificationSettings(): NotificationSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    cachedSettings = {
      enabled: parsed.enabled !== false,
      onlyWhenUnfocused: parsed.onlyWhenUnfocused !== false,
      inputRequired: typeof parsed.inputRequired === 'boolean' ? parsed.inputRequired : parsed.enabled !== false,
      approvalRequired: typeof parsed.approvalRequired === 'boolean' ? parsed.approvalRequired : parsed.enabled !== false,
    };
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
  }
  return cachedSettings;
}

export function setNotificationSettings(next: Partial<NotificationSettings>): NotificationSettings {
  const merged = { ...getNotificationSettings() };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof NotificationSettings)[]) {
    if (typeof next[key] === 'boolean') merged[key] = next[key];
  }
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  cachedSettings = merged;
  return merged;
}

export function configureNotifications(input: {
  isWindowFocused: () => boolean;
  onActivate: (target: NotificationActivateTarget) => void;
}): void {
  isWindowFocused = input.isWindowFocused;
  onActivate = input.onActivate;
}

function shouldNotify(kind: 'done' | 'input' | 'approval'): boolean {
  const settings = getNotificationSettings();
  if (kind === 'done' && !settings.enabled) return false;
  if (kind === 'input' && !settings.inputRequired) return false;
  if (kind === 'approval' && !settings.approvalRequired) return false;
  if (!Notification.isSupported()) return false;
  if ((kind === 'done' ? settings.onlyWhenUnfocused : true) && isWindowFocused()) return false;
  return true;
}

function show(title: string, body: string, target: NotificationActivateTarget, kind: 'done' | 'input' | 'approval' = 'done'): void {
  if (!shouldNotify(kind)) return;
  try {
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => onActivate?.(target));
    notification.show();
  } catch (error) {
    // 通知失败绝不阻塞执行
    console.warn('[Notifications] failed to show notification:', error);
  }
}

export function isQuestionRequest(toolName: string, input: unknown): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'Question'
    || (!!input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions));
}

const inputNotices = new Set<string>();
export function notifySessionInput(row: SessionRow, requestId: string, question: boolean): void {
  const key = `${row.id}:${requestId}`;
  if (inputNotices.has(key)) return;
  inputNotices.add(key);
  if (inputNotices.size > 1000) inputNotices.delete(inputNotices.values().next().value!);
  show(question ? 'Agent needs your input' : 'Agent needs approval', row.title || 'Untitled thread',
    { kind: 'session', sessionId: row.id }, question ? 'input' : 'approval');
}

export function notifySessionDone(row: SessionRow): void {
  const failed = row.status === 'error';
  show(
    failed ? 'Agent run failed' : 'Agent run finished',
    row.title || 'Untitled thread',
    { kind: 'session', sessionId: row.id }
  );
}
