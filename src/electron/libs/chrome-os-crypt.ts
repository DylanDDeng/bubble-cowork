import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';

export const CHROME_V10_PREFIX = Buffer.from('v10');
export const CHROME_V11_PREFIX = Buffer.from('v11');
export const CHROME_V20_PREFIX = Buffer.from('v20');
export const CHROME_COOKIE_DOMAIN_HASH_LENGTH = 32;
/** Cookie DB `meta.version` >= 24 prepends SHA-256(host_key) before encryption (Chrome 130+). */
export const CHROME_COOKIE_DB_HASH_VERSION = 24;
const MACOS_SALT = Buffer.from('saltysalt');
const MACOS_IV = Buffer.alloc(16, 0x20);
const MACOS_ITERATIONS = 1003;
const MACOS_KEY_LENGTH = 16;

export function deriveChromeMacOsCryptKey(password: string): Buffer {
  return pbkdf2Sync(password, MACOS_SALT, MACOS_ITERATIONS, MACOS_KEY_LENGTH, 'sha1');
}

export function encryptedValuePrefix(encryptedValue: Buffer): 'v10' | 'v11' | 'v20' | 'none' {
  if (encryptedValue.length >= 3 && encryptedValue.subarray(0, 3).equals(CHROME_V20_PREFIX)) return 'v20';
  if (encryptedValue.length >= 3 && encryptedValue.subarray(0, 3).equals(CHROME_V11_PREFIX)) return 'v11';
  if (encryptedValue.length >= 3 && encryptedValue.subarray(0, 3).equals(CHROME_V10_PREFIX)) return 'v10';
  return 'none';
}

export function sha256HostKey(hostKey: string): Buffer {
  return createHash('sha256').update(hostKey, 'utf8').digest();
}

export function stripChromeCookieDomainHash(plaintext: Buffer, hostKey: string): Buffer | null {
  if (plaintext.length < CHROME_COOKIE_DOMAIN_HASH_LENGTH) return null;
  const expected = sha256HostKey(hostKey);
  if (!plaintext.subarray(0, CHROME_COOKIE_DOMAIN_HASH_LENGTH).equals(expected)) return null;
  return plaintext.subarray(CHROME_COOKIE_DOMAIN_HASH_LENGTH);
}

export function encryptChromeV10Bytes(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, MACOS_IV);
  return Buffer.concat([CHROME_V10_PREFIX, cipher.update(plaintext), cipher.final()]);
}

export function encryptChromeV10(plaintext: string, key: Buffer): Buffer {
  return encryptChromeV10Bytes(Buffer.from(plaintext, 'utf8'), key);
}

export function encryptChromeV10WithDomainHash(plaintext: string, hostKey: string, key: Buffer): Buffer {
  return encryptChromeV10Bytes(Buffer.concat([sha256HostKey(hostKey), Buffer.from(plaintext, 'utf8')]), key);
}

export function decryptChromeOsCryptBytes(encryptedValue: Buffer, key: Buffer): Buffer | null {
  const prefix = encryptedValuePrefix(encryptedValue);
  if (prefix === 'v20' || prefix === 'none') return null;
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, MACOS_IV);
    return Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
}

export function decryptChromeOsCryptValue(encryptedValue: Buffer, key: Buffer): string | null {
  const decrypted = decryptChromeOsCryptBytes(encryptedValue, key);
  return decrypted == null ? null : decrypted.toString('utf8');
}

export function decryptChromeCookieValue(
  encryptedValue: Buffer,
  key: Buffer,
  hostKey: string,
  dbVersion: number
): string | null {
  const decrypted = decryptChromeOsCryptBytes(encryptedValue, key);
  if (decrypted == null) return null;
  const stripped = stripChromeCookieDomainHash(decrypted, hostKey);
  if (dbVersion >= CHROME_COOKIE_DB_HASH_VERSION) {
    if (!stripped) return null;
    return stripped.toString('utf8');
  }
  return (stripped ?? decrypted).toString('utf8');
}
