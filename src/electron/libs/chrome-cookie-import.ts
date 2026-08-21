import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir as osHomedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type {
  ChromeCookieDomain,
  ChromeCookieDomainsResult,
  ChromeCookieImportCounts,
  ChromeCookieImportRequest,
  ChromeCookieImportResult,
  ChromeCookieImportStatus,
  ChromeCookieProfile,
  ChromeCookieProfilesResult,
} from '../../shared/types';
import { BROWSER_SESSION_PARTITION } from '../../shared/browser-types';
import { pinBrowserUseOriginsAsk } from './browser-use-permissions';
import { decryptChromeCookieValue, deriveChromeMacOsCryptKey, encryptedValuePrefix } from './chrome-os-crypt';

const execFileAsync = promisify(execFile);
const WINDOWS_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const MAX_COOKIE_BYTES = 4096;

export interface ImportedCookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface ElectronCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface ElectronCookieStore {
  get(filter: { url?: string; name?: string; domain?: string }): Promise<ElectronCookieRecord[]>;
  set(details: ImportedCookieDetails): Promise<void>;
  remove(url: string, name: string): Promise<void>;
  flushStore(): Promise<void>;
}

export interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  has_expires: number;
  is_persistent: number;
  samesite: number;
  top_frame_site_key?: string;
}

export interface ChromeCookieImportDeps {
  platform?: NodeJS.Platform;
  homedir?: () => string;
  chromeUserDataDir?: string;
  nowMs?: () => number;
  isChromeRunning?: () => Promise<boolean>;
  readSafeStoragePassword?: () => Promise<string>;
  cookieStore?: ElectronCookieStore;
  importStatePath?: string;
  mkdtemp?: (prefix: string) => Promise<string>;
}

type LocalStateProfile = {
  name?: string;
  gaia_name?: string;
  user_name?: string;
};

interface LastImportState {
  importedAt: number;
  profilePath: string;
  profileName: string;
  domains: string[];
  hosts: string[];
  cookieCount: number;
}

function defaultChromeUserDataDir(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
}

function defaultImportStatePath(home: string): string {
  return process.env.AEGIS_CHROME_COOKIE_IMPORT_STATE_PATH?.trim() || join(home, '.aegis', 'chrome-cookie-import.json');
}

export function chromeHostMatchesAllowlist(hostKey: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  const host = stripLeadingDot(hostKey).toLowerCase();
  return domains.some((entry) => {
    const domain = stripLeadingDot(entry).toLowerCase();
    if (!domain) return false;
    return host === domain;
  });
}

export function originsForImportedHosts(hosts: Iterable<string>): string[] {
  const origins: string[] = [];
  for (const host of hosts) {
    const clean = stripLeadingDot(host).trim().toLowerCase();
    if (!clean) continue;
    origins.push(`https://${clean}`, `http://${clean}`);
  }
  return origins;
}

function uniqueHosts(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => stripLeadingDot(value).trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
}

export function stripLeadingDot(host: string): string {
  return host.startsWith('.') ? host.slice(1) : host;
}

export function isHostOnlyCookie(hostKey: string): boolean {
  return !hostKey.startsWith('.');
}

export function mapChromeSameSite(value: number): ImportedCookieDetails['sameSite'] {
  if (value === 0) return 'no_restriction';
  if (value === 2) return 'strict';
  if (value === -1) return 'unspecified';
  return 'lax';
}

export function chromeExpiryToUnixSeconds(expiresUtc: number): number {
  return Math.floor(expiresUtc / 1_000_000) - WINDOWS_EPOCH_OFFSET_SECONDS;
}

export function cookieUrlForRow(hostKey: string, path: string, secure: boolean): string | null {
  const host = stripLeadingDot(hostKey);
  if (!host || host.includes('/') || host.includes(':')) return null;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  try {
    return new URL(`${secure ? 'https' : 'http'}://${host}${normalizedPath}`).href;
  } catch {
    return null;
  }
}

export function mapChromeCookieRow(
  row: ChromeCookieRow,
  decryptedValue: string,
  nowMs: number
): { ok: true; details: ImportedCookieDetails } | { ok: false; reason: 'expired' | 'invalid' } {
  const path = row.path?.startsWith('/') ? row.path : '/';
  const secure = row.is_secure === 1;
  const sameSite = mapChromeSameSite(row.samesite);
  if (sameSite === 'no_restriction' && !secure) return { ok: false, reason: 'invalid' };
  if (row.name.startsWith('__Host-') && (!secure || path !== '/' || !isHostOnlyCookie(row.host_key))) {
    return { ok: false, reason: 'invalid' };
  }
  if (row.name.startsWith('__Secure-') && !secure) return { ok: false, reason: 'invalid' };
  if (!row.name) return { ok: false, reason: 'invalid' };

  const persistent = row.is_persistent === 1 && row.has_expires === 1 && row.expires_utc > 0;
  let expirationDate: number | undefined;
  if (persistent) {
    expirationDate = chromeExpiryToUnixSeconds(row.expires_utc);
    if (expirationDate * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  }

  const url = cookieUrlForRow(row.host_key, path, secure);
  if (!url) return { ok: false, reason: 'invalid' };
  if (Buffer.byteLength(decryptedValue, 'utf8') > MAX_COOKIE_BYTES) return { ok: false, reason: 'invalid' };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(decryptedValue)) return { ok: false, reason: 'invalid' };

  const details: ImportedCookieDetails = {
    url,
    name: row.name,
    value: decryptedValue,
    path,
    secure,
    httpOnly: row.is_httponly === 1,
    sameSite,
  };
  if (!isHostOnlyCookie(row.host_key) && !row.name.startsWith('__Host-')) {
    details.domain = stripLeadingDot(row.host_key);
  }
  if (expirationDate != null) details.expirationDate = expirationDate;
  return { ok: true, details };
}

export function isPartitionedCookie(row: ChromeCookieRow): boolean {
  const key = row.top_frame_site_key?.trim() ?? '';
  return key.length > 0;
}

function resolveDeps(overrides: ChromeCookieImportDeps = {}): Required<
  Pick<
    ChromeCookieImportDeps,
    'platform' | 'homedir' | 'nowMs' | 'isChromeRunning' | 'readSafeStoragePassword' | 'mkdtemp'
  >
> & { chromeUserDataDir: string; importStatePath: string; cookieStore?: ElectronCookieStore } {
  const home = (overrides.homedir ?? osHomedir)();
  const chromeUserDataDir =
    overrides.chromeUserDataDir ||
    process.env.AEGIS_CHROME_USER_DATA_DIR?.trim() ||
    defaultChromeUserDataDir(home);
  return {
    platform: overrides.platform ?? process.platform,
    homedir: overrides.homedir ?? osHomedir,
    chromeUserDataDir,
    nowMs: overrides.nowMs ?? Date.now,
    isChromeRunning: overrides.isChromeRunning ?? detectGoogleChromeRunning,
    readSafeStoragePassword: overrides.readSafeStoragePassword ?? readChromeSafeStoragePassword,
    cookieStore: overrides.cookieStore,
    importStatePath: overrides.importStatePath || defaultImportStatePath(home),
    mkdtemp: overrides.mkdtemp ?? ((prefix) => mkdtemp(prefix)),
  };
}

function cookieStoreOf(deps: { cookieStore?: ElectronCookieStore }): ElectronCookieStore {
  return deps.cookieStore ?? createElectronCookieStore();
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function createElectronCookieStore(): ElectronCookieStore {
  // Lazy require so unit tests can import this module without launching Electron.
  const { session } = require('electron') as typeof import('electron');
  const cookieJar = session.fromPartition(BROWSER_SESSION_PARTITION).cookies;
  return {
    async get(filter) {
      const cookies = await cookieJar.get(filter);
      return cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? '',
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite ?? 'unspecified',
      }));
    },
    async set(details) {
      await cookieJar.set(details);
    },
    async remove(url, name) {
      await cookieJar.remove(url, name);
    },
    flushStore() {
      return cookieJar.flushStore();
    },
  };
}

function reloadCoworkerBrowserViews(): void {
  try {
    const electron = require('electron') as typeof import('electron');
    const target = electron.session.fromPartition(BROWSER_SESSION_PARTITION);
    for (const contents of electron.webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.session !== target) continue;
      const url = contents.getURL();
      if (!url || url === 'about:blank') continue;
      contents.reload();
    }
  } catch {
    // Tests and startup paths may not have a ready Electron app.
  }
}

export function isGoogleChromeProcessName(comm: string): boolean {
  return comm.trim() === 'Google Chrome';
}

export async function detectGoogleChromeRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axc', '-o', 'comm='], {
      timeout: 5_000,
      encoding: 'utf8',
    });
    return stdout.split('\n').some((line) => isGoogleChromeProcessName(line));
  } catch {
    return false;
  }
}

/**
 * Reads Chrome's os_crypt password from macOS Keychain.
 * Uses /usr/bin/security so we do not add another native addon; the system
 * prompt may name `security` rather than the app. Only called after the user
 * confirms import in settings.
 */
export async function readChromeSafeStoragePassword(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'],
      { timeout: 30_000, encoding: 'utf8' }
    );
    const password = stdout.replace(/\n$/, '');
    if (!password) {
      const error = new Error('Chrome Safe Storage keychain item was empty.');
      (error as Error & { code?: string }).code = 'keychain_missing';
      throw error;
    }
    return password;
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const denied =
      stderr.includes('User interaction is not allowed') ||
      stderr.includes('(-128)') ||
      /denied/i.test(stderr);
    const wrapped = new Error(
      denied
        ? 'Keychain access was denied. Allow access to Chrome Safe Storage and try again.'
        : 'Could not read Chrome Safe Storage from Keychain. Unlock the login keychain and try again.'
    );
    (wrapped as Error & { code?: string }).code = denied ? 'keychain_denied' : 'keychain_missing';
    throw wrapped;
  }
}

function profileHasCookies(profilePath: string): boolean {
  return existsSync(join(profilePath, 'Network', 'Cookies')) || existsSync(join(profilePath, 'Cookies'));
}

function resolveCookieDbPath(profilePath: string): string | null {
  const nested = join(profilePath, 'Network', 'Cookies');
  if (existsSync(nested)) return nested;
  const legacy = join(profilePath, 'Cookies');
  if (existsSync(legacy)) return legacy;
  return null;
}

export function listChromeCookieProfiles(overrides: ChromeCookieImportDeps = {}): ChromeCookieProfilesResult {
  const deps = resolveDeps(overrides);
  if (deps.platform !== 'darwin') {
    return {
      platformSupported: false,
      chromeRunning: false,
      profiles: [],
      errorCode: 'unsupported_platform',
      errorMessage: 'Chrome cookie import is available on macOS. Windows Chrome uses App-Bound Encryption and cannot be imported.',
    };
  }

  const root = deps.chromeUserDataDir;
  const localStatePath = join(root, 'Local State');
  if (!existsSync(localStatePath)) {
    return { platformSupported: true, chromeRunning: false, profiles: [] };
  }

  let infoCache: Record<string, LocalStateProfile> = {};
  try {
    const parsed = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
      profile?: { info_cache?: Record<string, LocalStateProfile> };
    };
    infoCache = parsed.profile?.info_cache ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        platformSupported: true,
        chromeRunning: false,
        profiles: [],
        errorCode: 'app_data_denied',
        errorMessage:
          'macOS blocked access to Chrome data. Allow this app to access data from other apps in Privacy & Security, then try again.',
      };
    }
    return { platformSupported: true, chromeRunning: false, profiles: [] };
  }

  const profiles: ChromeCookieProfile[] = [];
  for (const [directoryName, info] of Object.entries(infoCache)) {
    if (directoryName === 'System Profile' || directoryName === 'Guest Profile') continue;
    const profilePath = join(root, directoryName);
    profiles.push({
      directoryName,
      profileName: info.name?.trim() || directoryName,
      profilePath,
      gaiaName: info.gaia_name?.trim() || undefined,
      userName: info.user_name?.trim() || undefined,
      hasCookies: profileHasCookies(profilePath),
    });
  }
  profiles.sort((a, b) => a.profileName.localeCompare(b.profileName));
  return { platformSupported: true, chromeRunning: false, profiles };
}

async function withCopiedCookieDb<T>(
  profilePath: string,
  mkdtempFn: (prefix: string) => Promise<string>,
  fn: (dbPath: string) => T | Promise<T>
): Promise<T> {
  const source = resolveCookieDbPath(profilePath);
  if (!source) {
    const error = new Error('This Chrome profile has no cookies database.');
    (error as Error & { code?: string }).code = 'no_cookies_db';
    throw error;
  }
  const dir = await mkdtempFn(join(tmpdir(), 'aegis-chrome-cookies-'));
  try {
    const dest = join(dir, 'Cookies');
    copyFileSync(source, dest);
    for (const suffix of ['-wal', '-shm', '-journal'] as const) {
      const extra = `${source}${suffix}`;
      if (existsSync(extra)) copyFileSync(extra, `${dest}${suffix}`);
    }
    return await fn(dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      const wrapped = new Error(
        'macOS blocked access to Chrome cookies. Allow this app to access data from other apps in Privacy & Security, then try again.'
      );
      (wrapped as Error & { code?: string }).code = 'app_data_denied';
      throw wrapped;
    }
    if (isSqliteBusyError(error)) {
      const wrapped = new Error(
        'Chrome is using the cookies database. Keep Chrome open if you want Gmail session cookies, or quit it if this copy keeps failing.'
      );
      (wrapped as Error & { code?: string }).code = 'chrome_running';
      throw wrapped;
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
  }
}

function openCookiesDatabase(dbPath: string): Database.Database {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    return db;
  } catch (error) {
    if (isSqliteBusyError(error)) {
      const wrapped = new Error(
        'Chrome is using the cookies database. Keep Chrome open if you want Gmail session cookies, or quit it if this copy keeps failing.'
      );
      (wrapped as Error & { code?: string }).code = 'chrome_running';
      throw wrapped;
    }
    throw error;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked/i.test(message);
}

function readCookieDbVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
    const version = Number.parseInt(String(row?.value ?? ''), 10);
    return Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

function readCookieRows(db: Database.Database): ChromeCookieRow[] {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(cookies)').all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!columns.has('host_key') || !columns.has('encrypted_value')) return [];
  const hasPartition = columns.has('top_frame_site_key');
  const sql = hasPartition
    ? `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly,
              has_expires, is_persistent, samesite, top_frame_site_key
       FROM cookies`
    : `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly,
              has_expires, is_persistent, samesite
       FROM cookies`;
  return db.prepare(sql).all() as ChromeCookieRow[];
}

export async function listChromeCookieDomains(
  profilePath: string,
  overrides: ChromeCookieImportDeps = {}
): Promise<ChromeCookieDomainsResult> {
  const deps = resolveDeps(overrides);
  if (deps.platform !== 'darwin') {
    return {
      domains: [],
      errorCode: 'unsupported_platform',
      errorMessage: 'Chrome cookie import is available on macOS.',
    };
  }
  if (!existsSync(profilePath) || !isPathInside(deps.chromeUserDataDir, profilePath)) {
    return { domains: [], errorCode: 'profile_not_found', errorMessage: 'That Chrome profile is no longer available.' };
  }
  try {
    const domains = await withCopiedCookieDb(profilePath, deps.mkdtemp, (dbPath) => {
      const db = openCookiesDatabase(dbPath);
      try {
        const counts = new Map<string, number>();
        for (const row of readCookieRows(db)) {
          const host = stripLeadingDot(row.host_key);
          if (!host) continue;
          counts.set(host, (counts.get(host) ?? 0) + 1);
        }
        return [...counts.entries()]
          .map(([host, cookieCount]) => ({ host, cookieCount }))
          .sort((a, b) => b.cookieCount - a.cookieCount || a.host.localeCompare(b.host));
      } finally {
        db.close();
      }
    });
    return { domains };
  } catch (error) {
    return { domains: [], errorCode: errorCodeOf(error), errorMessage: errorMessageOf(error) };
  }
}

export async function importChromeCookies(
  request: ChromeCookieImportRequest,
  overrides: ChromeCookieImportDeps = {}
): Promise<ChromeCookieImportResult> {
  const deps = resolveDeps(overrides);
  if (deps.platform !== 'darwin') {
    return {
      ok: false,
      errorCode: 'unsupported_platform',
      errorMessage: 'Chrome cookie import is available on macOS. Windows Chrome uses App-Bound Encryption and cannot be imported.',
    };
  }
  const domains = [...new Set((request.domains ?? []).map((domain) => stripLeadingDot(domain).trim()).filter(Boolean))];
  const importAll = domains.length === 0;
  if (!existsSync(request.profilePath) || !isPathInside(deps.chromeUserDataDir, request.profilePath)) {
    return { ok: false, errorCode: 'profile_not_found', errorMessage: 'That Chrome profile is no longer available.' };
  }

  try {
    return await withCopiedCookieDb(request.profilePath, deps.mkdtemp, async (dbPath) => {
      const db = openCookiesDatabase(dbPath);
      let rows: ChromeCookieRow[];
      let dbVersion = 0;
      try {
        dbVersion = readCookieDbVersion(db);
        const allRows = readCookieRows(db);
        rows = importAll ? allRows : allRows.filter((row) => chromeHostMatchesAllowlist(row.host_key, domains));
      } finally {
        db.close();
      }
      const cleanupHosts = importAll
        ? uniqueHosts(rows.map((row) => stripLeadingDot(row.host_key)))
        : domains;

      if (rows.some((row) => encryptedValuePrefix(asBuffer(row.encrypted_value)) === 'v20')) {
        return {
          ok: false,
          errorCode: 'v20_unsupported' as const,
          errorMessage: 'This Chrome profile uses App-Bound Encryption (v20 cookies), which cannot be imported.',
        };
      }

      const counts: ChromeCookieImportCounts = {
        discovered: rows.length,
        imported: 0,
        skippedExpired: 0,
        skippedPartitioned: 0,
        skippedInvalid: 0,
        failed: 0,
      };
      const mapped: ImportedCookieDetails[] = [];
      let decryptFailures = 0;
      let writeFailures = 0;
      const nowMs = deps.nowMs();
      let key: Buffer | null = null;

      if (rows.some((row) => cookieNeedsOsCrypt(row))) {
        let password: string;
        try {
          password = await deps.readSafeStoragePassword();
        } catch (error) {
          return { ok: false, errorCode: errorCodeOf(error), errorMessage: errorMessageOf(error) };
        }
        key = deriveChromeMacOsCryptKey(password);
      }

      for (const row of rows) {
        if (isPartitionedCookie(row)) {
          counts.skippedPartitioned += 1;
          continue;
        }
        const encrypted = asBuffer(row.encrypted_value);
        const prefix = encryptedValuePrefix(encrypted);
        let plaintext = row.value || '';
        if (encrypted.length > 0) {
          if (prefix === 'none') {
            counts.skippedInvalid += 1;
            continue;
          }
          if (!key) {
            decryptFailures += 1;
            counts.failed += 1;
            continue;
          }
          const decrypted = decryptChromeCookieValue(encrypted, key, row.host_key, dbVersion);
          if (decrypted == null) {
            decryptFailures += 1;
            counts.failed += 1;
            continue;
          }
          plaintext = decrypted;
        }
        const mappedRow = mapChromeCookieRow(row, plaintext, nowMs);
        if (!mappedRow.ok) {
          if (mappedRow.reason === 'expired') counts.skippedExpired += 1;
          else counts.skippedInvalid += 1;
          continue;
        }
        mapped.push(mappedRow.details);
      }

      if (mapped.length === 0 && decryptFailures > 0 && counts.imported === 0) {
        return {
          ok: false,
          errorCode: 'decrypt_failed' as const,
          errorMessage: 'Could not decrypt Chrome cookies. Unlock the login keychain and try again.',
          cookies: counts,
        };
      }

      const cookieStore = cookieStoreOf(deps);
      const importedHosts = new Set<string>();
      const keepKeys = new Set<string>();

      for (const details of mapped) {
        try {
          await cookieStore.set(details);
          counts.imported += 1;
          importedHosts.add(stripLeadingDot(details.domain || hostnameOf(details.url)));
          keepKeys.add(importedCookieKey(details));
        } catch {
          writeFailures += 1;
          counts.failed += 1;
        }
      }

      if (counts.failed === 0) {
        await removeCookiesForDomains(cookieStore, cleanupHosts, keepKeys);
      }
      await cookieStore.flushStore();

      if (counts.imported > 0) {
        pinBrowserUseOriginsAsk(originsForImportedHosts(importedHosts));
        const previous = readLastImportState(deps.importStatePath);
        saveLastImportState(deps.importStatePath, {
          importedAt: nowMs,
          profilePath: request.profilePath,
          profileName: basename(request.profilePath),
          domains: uniqueHosts([...(previous?.domains ?? []), ...cleanupHosts]),
          hosts: uniqueHosts([...(previous?.hosts ?? []), ...importedHosts]),
          cookieCount: counts.imported,
        });
        if (!overrides.cookieStore) reloadCoworkerBrowserViews();
      }

      if (decryptFailures > 0 && writeFailures === 0) {
        return {
          ok: false,
          errorCode: 'decrypt_failed' as const,
          errorMessage: 'Could not decrypt some Chrome cookies. Unlock the login keychain and try again.',
          cookies: counts,
          importedHosts: [...importedHosts].sort(),
        };
      }

      if (writeFailures > 0) {
        return {
          ok: false,
          errorCode: 'write_failed' as const,
          errorMessage:
            'Some cookies could not be written to the built-in browser. Existing cookies for those names were left unchanged.',
          cookies: counts,
          importedHosts: [...importedHosts].sort(),
        };
      }

      return {
        ok: true,
        cookies: counts,
        importedHosts: [...importedHosts].sort(),
      };
    });
  } catch (error) {
    return { ok: false, errorCode: errorCodeOf(error), errorMessage: errorMessageOf(error) };
  }
}

export function getChromeCookieImportStatus(overrides: ChromeCookieImportDeps = {}): ChromeCookieImportStatus {
  const deps = resolveDeps(overrides);
  const state = readLastImportState(deps.importStatePath);
  if (!state) return { importedAt: null, profileName: null, domains: [], cookieCount: 0 };
  return {
    importedAt: state.importedAt,
    profileName: state.profileName,
    domains: state.domains,
    cookieCount: state.cookieCount,
  };
}

export async function clearImportedChromeCookies(
  overrides: ChromeCookieImportDeps = {}
): Promise<{ ok: boolean; removed: number; errorMessage?: string }> {
  const deps = resolveDeps(overrides);
  const state = readLastImportState(deps.importStatePath);
  const toClear = uniqueHosts([...(state?.domains ?? []), ...(state?.hosts ?? [])]);
  if (!state || toClear.length === 0) return { ok: true, removed: 0 };
  const cookieStore = cookieStoreOf(deps);
  const removed = await removeCookiesForDomains(cookieStore, toClear);
  await cookieStore.flushStore();
  saveLastImportState(deps.importStatePath, null);
  return { ok: true, removed };
}

export async function listChromeCookieProfilesWithRunning(
  overrides: ChromeCookieImportDeps = {}
): Promise<ChromeCookieProfilesResult> {
  const listed = listChromeCookieProfiles(overrides);
  if (!listed.platformSupported) return listed;
  const deps = resolveDeps(overrides);
  listed.chromeRunning = await deps.isChromeRunning();
  return listed;
}

async function removeCookiesForDomains(
  store: ElectronCookieStore,
  domains: string[],
  keepKeys: Set<string> = new Set()
): Promise<number> {
  const existing = await store.get({});
  let removed = 0;
  for (const cookie of existing) {
    if (!chromeHostMatchesAllowlist(cookie.domain, domains)) continue;
    if (keepKeys.has(storedCookieKey(cookie))) continue;
    const url = cookieUrlForRow(cookie.domain.startsWith('.') ? cookie.domain : cookie.domain, cookie.path, cookie.secure);
    if (!url) continue;
    try {
      await store.remove(url, cookie.name);
      removed += 1;
    } catch {
      // keep going
    }
  }
  return removed;
}

function cookieNeedsOsCrypt(row: ChromeCookieRow): boolean {
  if (isPartitionedCookie(row)) return false;
  const encrypted = asBuffer(row.encrypted_value);
  if (encrypted.length === 0) return false;
  const prefix = encryptedValuePrefix(encrypted);
  return prefix === 'v10' || prefix === 'v11';
}

function importedCookieKey(details: ImportedCookieDetails): string {
  const domain = stripLeadingDot(details.domain || hostnameOf(details.url)).toLowerCase();
  return `${details.name}\0${domain}\0${details.path}\0${details.secure ? '1' : '0'}`;
}

function storedCookieKey(cookie: ElectronCookieRecord): string {
  return `${cookie.name}\0${stripLeadingDot(cookie.domain).toLowerCase()}\0${cookie.path}\0${cookie.secure ? '1' : '0'}`;
}

function asBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.from(value);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function errorCodeOf(error: unknown): ChromeCookieImportResult['errorCode'] {
  const code = (error as { code?: string }).code;
  if (
    code === 'unsupported_platform' ||
    code === 'chrome_running' ||
    code === 'profile_not_found' ||
    code === 'no_cookies_db' ||
    code === 'v20_unsupported' ||
    code === 'keychain_denied' ||
    code === 'keychain_missing' ||
    code === 'app_data_denied' ||
    code === 'no_domains_selected' ||
    code === 'decrypt_failed' ||
    code === 'write_failed' ||
    code === 'import_failed'
  ) {
    return code;
  }
  if (code === 'EPERM' || code === 'EACCES') return 'app_data_denied';
  return 'import_failed';
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Chrome cookie import failed.';
}

function readLastImportState(path: string): LastImportState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LastImportState;
    if (!parsed || typeof parsed.importedAt !== 'number' || !Array.isArray(parsed.domains)) return null;
    return {
      importedAt: parsed.importedAt,
      profilePath: typeof parsed.profilePath === 'string' ? parsed.profilePath : '',
      profileName: typeof parsed.profileName === 'string' ? parsed.profileName : '',
      domains: uniqueHosts(parsed.domains),
      hosts: uniqueHosts(Array.isArray(parsed.hosts) ? parsed.hosts : []),
      cookieCount: typeof parsed.cookieCount === 'number' && parsed.cookieCount > 0 ? parsed.cookieCount : 0,
    };
  } catch {
    return null;
  }
}

function saveLastImportState(path: string, state: LastImportState | null): void {
  mkdirSync(dirname(path), { recursive: true });
  if (state == null) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(path, JSON.stringify(state));
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}
