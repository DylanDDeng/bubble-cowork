import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../../../shared/attachment-policy';
import { DEEPSEEK_IMAGE_MIME_TYPES, type DeepseekImageMimeType } from '../../../shared/deepseek-images';
import type { Attachment } from '../../../shared/types';
import type { DshContentBlock } from './deepseek-sdk-loader';

/** Shared by the runtime and preview reader; never changes the user's DSH_HOME. */
export function resolveDeepseekAttachmentHome(): string {
  return path.resolve(process.env.AEGIS_DSH_ATTACHMENT_HOME?.trim() || path.join(homedir(), '.aegis', 'deepseek'));
}

export function deepseekImageBlocks(content: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(content) ? content : []).flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'image') return [block];
    return block.type === 'tool-result' ? deepseekImageBlocks(block.content) : [];
  });
}

export async function buildDeepseekPromptBlocks(prompt: string, attachments?: Attachment[]): Promise<DshContentBlock[]> {
  const blocks: DshContentBlock[] = [];
  if (prompt.trim()) blocks.push({ type: 'text', text: prompt });
  if ((attachments?.filter((attachment) => attachment.kind === 'image').length || 0) > 20) {
    throw new Error('DeepSeek accepts up to 20 images per message.');
  }
  for (const attachment of attachments || []) {
    if (attachment.kind === 'image') {
      if (!DEEPSEEK_IMAGE_MIME_TYPES.includes(attachment.mimeType as DeepseekImageMimeType)) {
        throw new Error(`${attachment.name}: DeepSeek supports PNG, JPEG, WebP and GIF images.`);
      }
      const file = await open(attachment.path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`${attachment.name}: image must be a nonempty file of at most 10 MB.`);
        }
        // Bound reads even if an external file grows after stat(). The native
        // attachment service validates the actual format, dimensions and bytes.
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error(`${attachment.name}: image changed while reading.`);
          offset += read.bytesRead;
        }
        blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: attachment.mimeType as DeepseekImageMimeType });
      } finally { await file.close(); }
    } else {
      blocks.push({ type: 'text', text: attachment.previewText?.trim()
        ? `Attachment: ${attachment.name}\nPath: ${attachment.path}\n\n${attachment.previewText}`
        : `Attachment available on disk: ${attachment.path}` });
    }
  }
  return blocks;
}

/** Export validated native immutable objects to extension-bearing preview paths.
 * Aegis history stores paths and metadata only, never base64 image payloads.
 */
export async function deepseekToolImages(content: unknown, home: string): Promise<Attachment[]> {
  const images: Attachment[] = [];
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  for (const block of deepseekImageBlocks(content)) {
    const ref = block.attachment as Record<string, unknown> | undefined;
    const hash = typeof ref?.attachmentId === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(ref.attachmentId)?.[1] : undefined;
    const extension = typeof ref?.mediaType === 'string' ? extensions[ref.mediaType] : undefined;
    if (!hash || !extension || typeof ref?.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('Invalid DeepSeek image reference.');
    }
    if (images.some((image) => image.id === `deepseek-image:${hash}`)) continue;
    if (images.length >= 20) throw new Error('Too many DeepSeek image previews.');
    const objectPath = path.join(home, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash);
    const objectStat = await stat(objectPath);
    if (!objectStat.isFile() || objectStat.size !== ref.bytes) throw new Error('DeepSeek image failed integrity verification.');
    const data = await readFile(objectPath);
    if (data.length !== ref.bytes || createHash('sha256').update(data).digest('hex') !== hash) {
      throw new Error('DeepSeek image failed integrity verification.');
    }
    const directory = path.join(home, 'previews');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const previewPath = path.join(directory, `${hash}.${extension}`);
    // Concurrent reads of the same image must never expose a partial preview.
    const temporaryPath = `${previewPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, previewPath);
    } finally { await rm(temporaryPath, { force: true }); }
    images.push({ id: `deepseek-image:${hash}`, path: previewPath,
      name: typeof ref.name === 'string' ? `${path.parse(path.basename(ref.name)).name}.${extension}` : `Image.${extension}`,
      size: ref.bytes, mimeType: ref.mediaType as DeepseekImageMimeType, kind: 'image' });
  }
  return images;
}
