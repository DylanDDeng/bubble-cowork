export const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.log': 'text/plain', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_ATTACHMENT_BYTES = 512 * 1024 * 1024;
// Native files travel by path. Bound memory for clipboard-only blobs.
export const MAX_INLINE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export function attachmentExtension(name: string): string {
  return name.match(/\.[^.\\/]+$/)?.[0].toLowerCase() || '';
}
export function attachmentSizeLimit(name: string): number {
  return ATTACHMENT_MIME_TYPES[attachmentExtension(name)]?.startsWith('video/')
    ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
}
export interface AttachmentImportResult {
  attachments: import('./types').Attachment[];
  errors: string[];
}
