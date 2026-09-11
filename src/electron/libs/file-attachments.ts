import { app, clipboard } from 'electron';
import { createHash, randomUUID } from 'crypto';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { constants, promises as fs } from 'fs';
import { ATTACHMENT_MIME_TYPES, attachmentExtension, attachmentSizeLimit, MAX_INLINE_ATTACHMENT_BYTES } from '../../shared/attachment-policy';
import type { AttachmentImportResult } from '../../shared/attachment-policy';
import type { Attachment } from '../../shared/types';

function validateFile(name: string, size: number): string {
  const mimeType = ATTACHMENT_MIME_TYPES[attachmentExtension(name)];
  if (!mimeType) throw new Error(`${name}: this file format is not supported.`);
  const max = attachmentSizeLimit(name);
  if (size > max) throw new Error(`${name}: maximum size is ${max / 1024 / 1024} MB.`);
  if (size === 0) throw new Error(`${name}: this file is empty.`);
  return mimeType;
}
function metadata(id: string, path: string, name: string, size: number, mimeType: string): Attachment {
  return { id, path, name, size, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file' };
}
export async function importAttachmentPaths(paths: string[]): Promise<AttachmentImportResult> {
  const result: AttachmentImportResult = { attachments: [], errors: [] };
  if (!Array.isArray(paths) || paths.length > 32) throw new Error('Attach up to 32 files at a time.');
  for (const source of new Set(paths)) {
    try {
      if (typeof source !== 'string') throw new Error('Invalid file path.');
      const real = await fs.realpath(source);
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new Error(`${basename(source)}: select a file, not a folder.`);
      const name = basename(real);
      const mimeType = validateFile(name, stat.size);
      const id = createHash('sha256').update(`${real}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
      const dir = join(app.getPath('userData'), 'attachments', 'files', id);
      const target = join(dir, name);
      await fs.mkdir(dir, { recursive: true });
      // Reattaching the same file reuses its snapshot and deduplicates in the composer.
      try {
        await fs.access(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const temporary = join(dir, `.import-${randomUUID()}`);
        try {
          await fs.copyFile(real, temporary, constants.COPYFILE_EXCL);
          // Publish only complete snapshots, including concurrent imports of the same file.
          await fs.rename(temporary, target);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      result.attachments.push(metadata(id, target, name, stat.size, mimeType));
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : 'Could not attach this file.');
    }
  }
  return result;
}
export async function importAttachmentBytes(name: string, data: Uint8Array): Promise<Attachment> {
  if (typeof name !== 'string' || !data || !(data instanceof Uint8Array)) throw new Error('Invalid attachment.');
  const safeName = basename(name);
  const mimeType = validateFile(safeName, data.byteLength);
  if (data.byteLength > MAX_INLINE_ATTACHMENT_BYTES) throw new Error('Save this video as a file, then attach it using the file picker.');
  const id = randomUUID();
  const dir = join(app.getPath('userData'), 'attachments', 'files', id);
  await fs.mkdir(dir, { recursive: true });
  const target = join(dir, safeName);
  await fs.writeFile(target, data);
  return metadata(id, target, safeName, data.byteLength, mimeType);
}

export function clipboardFilePaths(): string[] {
  const formats = clipboard.availableFormats();
  const paths = new Set<string>();
  for (const format of ['public.file-url', 'text/uri-list']) {
    if (!formats.includes(format)) continue;
    const value = clipboard.readBuffer(format).toString('utf8');
    for (const line of value.split(/[\r\n\0]+/)) {
      if (!line.startsWith('file://')) continue;
      try { paths.add(fileURLToPath(line)); } catch { /* ignore non-local URLs */ }
    }
  }
  if (process.platform === 'darwin' && formats.includes('NSFilenamesPboardType')) {
    try {
      const buffer = clipboard.readBuffer('NSFilenamesPboardType');
      if (buffer.length > 0 && buffer.length < 1024 * 1024) {
        const parsed: unknown = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: buffer, timeout: 1000 }).toString());
        if (Array.isArray(parsed)) for (const path of parsed) if (typeof path === 'string') paths.add(path);
      }
    } catch { /* file URLs above may still be available */ }
  }
  return Array.from(paths);
}
