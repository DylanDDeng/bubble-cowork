import { ATTACHMENT_MIME_TYPES, attachmentExtension, attachmentSizeLimit, MAX_INLINE_ATTACHMENT_BYTES } from '../../shared/attachment-policy';
import type { AttachmentImportResult } from '../../shared/attachment-policy';

export async function importComposerFiles(files: File[]): Promise<AttachmentImportResult> {
  const result: AttachmentImportResult = { attachments: [], errors: [] };
  const paths: string[] = [];
  for (const file of files) {
    try {
      const path = window.electron.getPathForFile(file);
      if (path) { paths.push(path); continue; }
      const ext = attachmentExtension(file.name);
      const name = ext ? file.name : file.type === 'image/png' ? 'image.png' : file.type === 'image/jpeg' ? 'image.jpg' : file.type === 'image/webp' ? 'image.webp' : file.type === 'image/gif' ? 'image.gif' : file.name;
      if (!ATTACHMENT_MIME_TYPES[attachmentExtension(name)]) throw new Error(`${name}: this file format is not supported.`);
      if (file.size > attachmentSizeLimit(name)) throw new Error(`${name}: maximum size is ${attachmentSizeLimit(name) / 1024 / 1024} MB.`);
      if (file.size > MAX_INLINE_ATTACHMENT_BYTES) throw new Error(`${name}: save the video as a file, then attach it using the file picker.`);
      result.attachments.push(await window.electron.createFileAttachment(name, new Uint8Array(await file.arrayBuffer())));
    } catch (error) { result.errors.push(error instanceof Error ? error.message : 'Could not attach this file.'); }
  }
  if (paths.length) {
    const imported = await window.electron.importAttachments(paths);
    result.attachments.push(...imported.attachments);
    result.errors.push(...imported.errors);
  }
  return result;
}
