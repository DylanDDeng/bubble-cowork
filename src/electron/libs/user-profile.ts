import { execFile } from 'child_process';
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { userInfo } from 'os';
import { join } from 'path';
import type { UserProfile, UserProfileUpdate } from '../../shared/types';

type UserProfileFile = {
  version: 1;
  displayName: string | null;
  handle: string | null;
};

const USER_PROFILE_PATH = () => join(app.getPath('userData'), 'user-profile.json');

let cachedGitUserName: string | null | undefined;

function loadStoredProfile(): UserProfileFile {
  const configPath = USER_PROFILE_PATH();
  if (!existsSync(configPath)) {
    return { version: 1, displayName: null, handle: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<UserProfileFile>;
    return {
      version: 1,
      displayName: typeof parsed.displayName === 'string' && parsed.displayName.trim()
        ? parsed.displayName.trim()
        : null,
      handle: typeof parsed.handle === 'string' && parsed.handle.trim() ? sanitizeHandle(parsed.handle) : null,
    };
  } catch {
    return { version: 1, displayName: null, handle: null };
  }
}

function saveStoredProfile(profile: UserProfileFile): void {
  writeFileSync(USER_PROFILE_PATH(), JSON.stringify(profile, null, 2), 'utf-8');
}

function detectGitUserName(): Promise<string | null> {
  if (cachedGitUserName !== undefined) {
    return Promise.resolve(cachedGitUserName);
  }

  return new Promise((resolve) => {
    execFile('git', ['config', '--get', 'user.name'], { timeout: 3000 }, (error, stdout) => {
      const name = !error && stdout.trim() ? stdout.trim() : null;
      cachedGitUserName = name;
      resolve(name);
    });
  });
}

function detectOsUserName(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

export function sanitizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export async function getUserProfile(): Promise<UserProfile> {
  const stored = loadStoredProfile();
  const displayName =
    stored.displayName || (await detectGitUserName()) || detectOsUserName() || 'User';
  const handle = stored.handle || sanitizeHandle(displayName) || 'user';

  return {
    displayName,
    handle,
    customized: Boolean(stored.displayName || stored.handle),
  };
}

export async function saveUserProfile(update: UserProfileUpdate): Promise<UserProfile> {
  const displayName =
    typeof update.displayName === 'string' && update.displayName.trim()
      ? update.displayName.trim().slice(0, 64)
      : null;
  const handle =
    typeof update.handle === 'string' && sanitizeHandle(update.handle)
      ? sanitizeHandle(update.handle)
      : null;

  saveStoredProfile({ version: 1, displayName, handle });
  return getUserProfile();
}
