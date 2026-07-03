import { Notification, app } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RunGroupInfo } from '../../shared/types';
import type { SessionRow } from '../types';

export interface NotificationSettings {
  enabled: boolean;
  // 仅在窗口失焦/隐藏时弹（前台工作不打扰）
  onlyWhenUnfocused: boolean;
}

export type NotificationActivateTarget =
  | { kind: 'runGroup'; groupId: string }
  | { kind: 'session'; sessionId: string };

const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, onlyWhenUnfocused: true };

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
    };
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS };
  }
  return cachedSettings;
}

export function setNotificationSettings(next: Partial<NotificationSettings>): NotificationSettings {
  const merged = { ...getNotificationSettings(), ...next };
  cachedSettings = merged;
  try {
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (error) {
    console.warn('[Notifications] failed to persist settings:', error);
  }
  return merged;
}

export function configureNotifications(input: {
  isWindowFocused: () => boolean;
  onActivate: (target: NotificationActivateTarget) => void;
}): void {
  isWindowFocused = input.isWindowFocused;
  onActivate = input.onActivate;
}

function shouldNotify(): boolean {
  const settings = getNotificationSettings();
  if (!settings.enabled) return false;
  if (!Notification.isSupported()) return false;
  if (settings.onlyWhenUnfocused && isWindowFocused()) return false;
  return true;
}

function show(title: string, body: string, target: NotificationActivateTarget): void {
  if (!shouldNotify()) return;
  try {
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => onActivate?.(target));
    notification.show();
  } catch (error) {
    // 通知失败绝不阻塞执行
    console.warn('[Notifications] failed to show notification:', error);
  }
}

export function notifyRunGroupSettled(group: RunGroupInfo): void {
  const done = group.members.filter(
    (member) => member.phase !== 'failed' && member.sessionId
  ).length;
  const total = group.members.length;
  const failed = total - done;
  const body =
    failed > 0
      ? `${done}/${total} agents finished (${failed} failed) — compare results`
      : `${done}/${total} agents finished — compare results`;
  show('Fan-out complete', body, { kind: 'runGroup', groupId: group.id });
}

export function notifySessionDone(row: SessionRow): void {
  const failed = row.status === 'error';
  show(
    failed ? 'Agent run failed' : 'Agent run finished',
    row.title || 'Untitled thread',
    { kind: 'session', sessionId: row.id }
  );
}
