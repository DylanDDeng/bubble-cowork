import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  getBrowserUsePermissionSettings,
  pinBrowserUseOriginsAsk,
  resolveBrowserUsePolicy,
  saveBrowserUsePermissionSettings,
} from '../../src/electron/libs/browser-use-permissions';
import {
  chromeHostMatchesAllowlist,
  clearImportedChromeCookies,
  cookieUrlForRow,
  getChromeCookieImportStatus,
  importChromeCookies,
  isGoogleChromeProcessName,
  isHostOnlyCookie,
  listChromeCookieDomains,
  listChromeCookieProfiles,
  mapChromeCookieRow,
  mapChromeSameSite,
  originsForImportedHosts,
  type ChromeCookieRow,
  type ElectronCookieRecord,
  type ElectronCookieStore,
  type ImportedCookieDetails,
} from '../../src/electron/libs/chrome-cookie-import';
import {
  CHROME_COOKIE_DB_HASH_VERSION,
  CHROME_V20_PREFIX,
  decryptChromeCookieValue,
  decryptChromeOsCryptValue,
  deriveChromeMacOsCryptKey,
  encryptChromeV10,
  encryptChromeV10WithDomainHash,
  encryptedValuePrefix,
} from '../../src/electron/libs/chrome-os-crypt';

const PASSWORD = 'aegis-test-chrome-password';
const KEY = deriveChromeMacOsCryptKey(PASSWORD);

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aegis-chrome-import-'));
}

function createCookieRow(overrides: Partial<ChromeCookieRow> & Pick<ChromeCookieRow, 'host_key' | 'name'>): ChromeCookieRow {
  return {
    value: '',
    encrypted_value: Buffer.alloc(0),
    path: '/',
    expires_utc: 0,
    is_secure: 1,
    is_httponly: 1,
    has_expires: 0,
    is_persistent: 0,
    samesite: 1,
    top_frame_site_key: '',
    ...overrides,
  };
}

function persistentExpiry(daysAhead = 30): number {
  const unixSeconds = Math.floor(Date.now() / 1000) + daysAhead * 24 * 60 * 60;
  return (unixSeconds + 11_644_473_600) * 1_000_000;
}

function createMemoryCookieStore(
  options: { failOnNames?: Set<string> } = {}
): ElectronCookieStore & { records: Map<string, ElectronCookieRecord & { url: string }> } {
  const records = new Map<string, ElectronCookieRecord & { url: string }>();
  const keyOf = (url: string, name: string) => `${url}\0${name}`;
  return {
    records,
    async get(filter) {
      return [...records.values()].filter((cookie) => {
        if (filter.name && cookie.name !== filter.name) return false;
        if (filter.url && cookie.url !== filter.url) return false;
        if (filter.domain && cookie.domain.replace(/^\./, '') !== filter.domain.replace(/^\./, '')) return false;
        return true;
      });
    },
    async set(details: ImportedCookieDetails) {
      if (options.failOnNames?.has(details.name)) {
        throw new Error(`refusing to write ${details.name}`);
      }
      const record: ElectronCookieRecord & { url: string } = {
        url: details.url,
        name: details.name,
        value: details.value,
        domain: details.domain ?? new URL(details.url).hostname,
        path: details.path,
        secure: details.secure,
        httpOnly: details.httpOnly,
        expirationDate: details.expirationDate,
        sameSite: details.sameSite,
      };
      records.set(keyOf(details.url, details.name), record);
    },
    async remove(url, name) {
      records.delete(keyOf(url, name));
    },
    async flushStore() {},
  };
}

function writeChromeProfile(
  root: string,
  directoryName: string,
  rows: ChromeCookieRow[],
  options: { dbVersion?: number } = {}
): string {
  const profilePath = join(root, directoryName);
  mkdirSync(join(profilePath, 'Network'), { recursive: true });
  const db = new Database(join(profilePath, 'Network', 'Cookies'));
  db.exec(`
    CREATE TABLE cookies(
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      last_update_utc INTEGER NOT NULL DEFAULT 0,
      source_type INTEGER NOT NULL DEFAULT 0,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  `);
  if (options.dbVersion != null) {
    db.prepare("INSERT INTO meta(key, value) VALUES ('version', ?)").run(String(options.dbVersion));
  }
  const insert = db.prepare(`
    INSERT INTO cookies (
      host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
      is_secure, is_httponly, has_expires, is_persistent, samesite
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.host_key,
        row.top_frame_site_key ?? '',
        row.name,
        row.value,
        row.encrypted_value,
        row.path,
        row.expires_utc,
        row.is_secure,
        row.is_httponly,
        row.has_expires,
        row.is_persistent,
        row.samesite
      );
    }
  });
  write();
  db.close();
  return profilePath;
}

function writeLocalState(root: string, names: Record<string, { name: string; user_name?: string }>): void {
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: Object.fromEntries(
          Object.entries(names).map(([directoryName, info]) => [directoryName, info])
        ),
      },
    })
  );
}

async function run(): Promise<void> {
  const root = createTempDir();
  const permissionDir = createTempDir();
  const previousSettings = process.env.AEGIS_BROWSER_USE_SETTINGS_PATH;
  process.env.AEGIS_BROWSER_USE_SETTINGS_PATH = join(permissionDir, 'permissions.json');
  saveBrowserUsePermissionSettings({ enabled: true, defaultPolicy: 'allow', origins: {} });

  try {
    const roundTrip = encryptChromeV10('secret-cookie', KEY);
    assert.equal(encryptedValuePrefix(roundTrip), 'v10');
    const hashed = encryptChromeV10WithDomainHash('secret-cookie', '.github.com', KEY);
    assert.equal(decryptChromeCookieValue(hashed, KEY, '.github.com', CHROME_COOKIE_DB_HASH_VERSION), 'secret-cookie');
    assert.equal(decryptChromeCookieValue(hashed, KEY, '.evil.com', CHROME_COOKIE_DB_HASH_VERSION), null);
    assert.equal(decryptChromeOsCryptValue(roundTrip, KEY), 'secret-cookie');
    assert.equal(encryptedValuePrefix(Buffer.concat([CHROME_V20_PREFIX, Buffer.from('nope')])), 'v20');
    assert.equal(decryptChromeOsCryptValue(Buffer.concat([CHROME_V20_PREFIX, Buffer.from('nope')]), KEY), null);

    assert.equal(chromeHostMatchesAllowlist('.github.com', ['github.com']), true);
    assert.equal(chromeHostMatchesAllowlist('github.com', ['github.com']), true);
    assert.equal(chromeHostMatchesAllowlist('.api.github.com', ['github.com']), false);
    assert.equal(chromeHostMatchesAllowlist('evil.com', ['github.com']), false);
    assert.equal(isGoogleChromeProcessName('Google Chrome'), true);
    assert.equal(isGoogleChromeProcessName('Google Chrome Helper (Renderer)'), false);
    assert.equal(isGoogleChromeProcessName('Google Chrome Helper'), false);
    assert.equal(isGoogleChromeProcessName('Firefox'), false);
    assert.equal(isHostOnlyCookie('github.com'), true);
    assert.equal(isHostOnlyCookie('.github.com'), false);
    assert.equal(mapChromeSameSite(0), 'no_restriction');
    assert.equal(mapChromeSameSite(2), 'strict');
    assert.equal(cookieUrlForRow('.github.com', '/', true), 'https://github.com/');

    const hostOnly = mapChromeCookieRow(
      createCookieRow({
        host_key: 'github.com',
        name: 'user_session',
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      'abc',
      Date.now()
    );
    assert.equal(hostOnly.ok, true);
    if (hostOnly.ok) {
      assert.equal(hostOnly.details.domain, undefined);
      assert.equal(hostOnly.details.url, 'https://github.com/');
    }

    const domainCookie = mapChromeCookieRow(
      createCookieRow({
        host_key: '.github.com',
        name: 'logged_in',
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      'yes',
      Date.now()
    );
    assert.equal(domainCookie.ok, true);
    if (domainCookie.ok) assert.equal(domainCookie.details.domain, 'github.com');

    const noneWithoutSecure = mapChromeCookieRow(
      createCookieRow({ host_key: 'example.com', name: 'x', is_secure: 0, samesite: 0 }),
      'v',
      Date.now()
    );
    assert.equal(noneWithoutSecure.ok, false);

    const expired = mapChromeCookieRow(
      createCookieRow({
        host_key: 'example.com',
        name: 'old',
        is_persistent: 1,
        has_expires: 1,
        expires_utc: 1,
      }),
      'v',
      Date.now()
    );
    assert.equal(expired.ok, false);

    writeLocalState(root, {
      Default: { name: 'Person 1', user_name: 'ada@example.com' },
      'Profile 1': { name: 'Work' },
      'Guest Profile': { name: 'Guest' },
    });
    writeChromeProfile(root, 'Default', [
      createCookieRow({
        host_key: '.github.com',
        name: 'logged_in',
        encrypted_value: encryptChromeV10('yes', KEY),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
    ]);
    writeChromeProfile(root, 'Profile 1', []);
    const listed = listChromeCookieProfiles({ platform: 'darwin', chromeUserDataDir: root });
    assert.equal(listed.platformSupported, true);
    assert.deepEqual(
      listed.profiles.map((profile) => profile.directoryName).sort(),
      ['Default', 'Profile 1']
    );
    assert.equal(listed.profiles.find((profile) => profile.directoryName === 'Default')?.hasCookies, true);

    const unsupported = listChromeCookieProfiles({ platform: 'win32', chromeUserDataDir: root });
    assert.equal(unsupported.platformSupported, false);
    assert.equal(unsupported.errorCode, 'unsupported_platform');

    const defaultProfile = join(root, 'Default');
    const domainList = await listChromeCookieDomains(defaultProfile, {
      platform: 'darwin',
      chromeUserDataDir: root,
    });
    assert.deepEqual(
      domainList.domains.map((domain) => domain.host),
      ['github.com']
    );

    const store = createMemoryCookieStore();
    const mixedProfile = writeChromeProfile(root, 'Mixed', [
      createCookieRow({
        host_key: '.github.com',
        name: 'logged_in',
        encrypted_value: encryptChromeV10('yes', KEY),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      createCookieRow({
        host_key: 'github.com',
        name: 'user_session',
        encrypted_value: encryptChromeV10('session-value', KEY),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      createCookieRow({
        host_key: '.github.com',
        name: 'chips',
        encrypted_value: encryptChromeV10('partitioned', KEY),
        top_frame_site_key: 'https://embed.example',
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      createCookieRow({
        host_key: 'api.github.com',
        name: 'api_token',
        encrypted_value: encryptChromeV10('api', KEY),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
      createCookieRow({
        host_key: '.google.com',
        name: 'NID',
        encrypted_value: encryptChromeV10('google', KEY),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
    ]);

    const imported = await importChromeCookies(
      { profilePath: mixedProfile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: store,
        importStatePath: join(root, 'import-state.json'),
      }
    );
    assert.equal(imported.ok, true);
    assert.equal(imported.cookies?.imported, 2);
    assert.equal(imported.cookies?.skippedPartitioned, 1);
    assert.equal(imported.cookies?.discovered, 3);
    assert.equal(store.records.size, 2);
    assert.equal(
      [...store.records.values()].some((cookie) => cookie.name === 'api_token'),
      false
    );
    const sessionCookie = [...store.records.values()].find((cookie) => cookie.name === 'user_session');
    assert.ok(sessionCookie);
    assert.equal(sessionCookie.domain, 'github.com');
    const loggedIn = [...store.records.values()].find((cookie) => cookie.name === 'logged_in');
    assert.ok(loggedIn);
    assert.equal(loggedIn.domain, 'github.com');
    assert.equal(resolveBrowserUsePolicy('https://github.com/login'), 'ask');
    assert.equal(resolveBrowserUsePolicy('http://github.com/'), 'ask');
    assert.equal(resolveBrowserUsePolicy('https://api.github.com/'), 'ask');
    assert.equal(resolveBrowserUsePolicy('http://api.github.com/'), 'ask');
    assert.equal(resolveBrowserUsePolicy('https://other.example/'), 'allow');

    const allStore = createMemoryCookieStore();
    const importedAll = await importChromeCookies(
      { profilePath: mixedProfile },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: allStore,
        importStatePath: join(root, 'import-all-state.json'),
      }
    );
    assert.equal(importedAll.ok, true);
    assert.equal(importedAll.cookies?.imported, 4);
    assert.equal(importedAll.cookies?.skippedPartitioned, 1);
    assert.equal(allStore.records.size, 4);

    const googleImport = await importChromeCookies(
      { profilePath: mixedProfile, domains: ['google.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: store,
        importStatePath: join(root, 'import-state.json'),
      }
    );
    assert.equal(googleImport.ok, true);
    assert.equal(googleImport.cookies?.imported, 1);
    assert.equal(store.records.size, 3);
    const status = getChromeCookieImportStatus({ importStatePath: join(root, 'import-state.json') });
    assert.deepEqual(status.domains, ['github.com', 'google.com']);
    assert.equal(status.cookieCount, 1);
    const cleared = await clearImportedChromeCookies({
      cookieStore: store,
      importStatePath: join(root, 'import-state.json'),
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.removed, 3);
    assert.equal(store.records.size, 0);
    assert.equal(getChromeCookieImportStatus({ importStatePath: join(root, 'import-state.json') }).importedAt, null);

    const running = await importChromeCookies(
      { profilePath: mixedProfile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => true,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: store,
        importStatePath: join(root, 'import-state.json'),
      }
    );
    assert.equal(running.ok, true);
    assert.equal(running.cookies?.imported, 2);
    assert.equal(running.errorCode, undefined);

    const v20Profile = writeChromeProfile(root, 'V20', [
      createCookieRow({
        host_key: '.github.com',
        name: 'v20cookie',
        encrypted_value: Buffer.concat([CHROME_V20_PREFIX, Buffer.from('cipher')]),
        is_persistent: 1,
        has_expires: 1,
        expires_utc: persistentExpiry(),
      }),
    ]);
    const v20Store = createMemoryCookieStore();
    let v20KeychainCalls = 0;
    const v20Result = await importChromeCookies(
      { profilePath: v20Profile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => {
          v20KeychainCalls += 1;
          return PASSWORD;
        },
        cookieStore: v20Store,
        importStatePath: join(root, 'v20-state.json'),
      }
    );
    assert.equal(v20Result.ok, false);
    assert.equal(v20Result.errorCode, 'v20_unsupported');
    assert.equal(v20Store.records.size, 0);
    assert.equal(v20KeychainCalls, 0);

    const staleStore = createMemoryCookieStore();
    await staleStore.set({
      url: 'https://github.com/',
      name: 'stale',
      value: 'old',
      domain: 'github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    const replaced = await importChromeCookies(
      { profilePath: mixedProfile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: staleStore,
        importStatePath: join(root, 'stale-state.json'),
      }
    );
    assert.equal(replaced.ok, true);
    assert.equal(
      [...staleStore.records.values()].some((cookie) => cookie.name === 'stale'),
      false
    );
    assert.equal(staleStore.records.size, 2);

    const failingStore = createMemoryCookieStore({ failOnNames: new Set(['user_session']) });
    failingStore.records.set('https://github.com/\0user_session', {
      url: 'https://github.com/',
      name: 'user_session',
      value: 'old-session',
      domain: 'github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    const partial = await importChromeCookies(
      { profilePath: mixedProfile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: failingStore,
        importStatePath: join(root, 'partial-state.json'),
      }
    );
    assert.equal(partial.ok, false);
    assert.equal(partial.errorCode, 'write_failed');
    assert.equal(partial.cookies?.imported, 1);
    assert.equal(partial.cookies?.failed, 1);
    const leftoverSession = [...failingStore.records.values()].find((cookie) => cookie.name === 'user_session');
    assert.ok(leftoverSession);
    assert.equal(leftoverSession.value, 'old-session');
    assert.ok([...failingStore.records.values()].some((cookie) => cookie.name === 'logged_in'));

    const v24Store = createMemoryCookieStore();
    const v24Profile = writeChromeProfile(
      root,
      'V24',
      [
        createCookieRow({
          host_key: '.github.com',
          name: 'logged_in',
          encrypted_value: encryptChromeV10WithDomainHash('yes', '.github.com', KEY),
          is_persistent: 1,
          has_expires: 1,
          expires_utc: persistentExpiry(),
        }),
      ],
      { dbVersion: CHROME_COOKIE_DB_HASH_VERSION }
    );
    const v24Imported = await importChromeCookies(
      { profilePath: v24Profile, domains: ['github.com'] },
      {
        platform: 'darwin',
        chromeUserDataDir: root,
        isChromeRunning: async () => false,
        readSafeStoragePassword: async () => PASSWORD,
        cookieStore: v24Store,
        importStatePath: join(root, 'v24-state.json'),
      }
    );
    assert.equal(v24Imported.ok, true);
    assert.equal(v24Imported.cookies?.imported, 1);
    assert.equal([...v24Store.records.values()][0]?.value, 'yes');

    pinBrowserUseOriginsAsk(['https://pinned.example']);
    saveBrowserUsePermissionSettings({
      ...getBrowserUsePermissionSettings(),
      defaultPolicy: 'allow',
    });
    assert.equal(resolveBrowserUsePolicy('https://pinned.example/app'), 'ask');

    console.log('chrome-cookie-import tests passed');
  } finally {
    if (previousSettings) process.env.AEGIS_BROWSER_USE_SETTINGS_PATH = previousSettings;
    else delete process.env.AEGIS_BROWSER_USE_SETTINGS_PATH;
    rmSync(root, { recursive: true, force: true });
    rmSync(permissionDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
