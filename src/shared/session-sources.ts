import type { Attachment, StreamMessage } from './types';

export type SessionSourcePreview =
  | { kind: 'image' | 'video' | 'audio' | 'pdf'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'file' }
  | { kind: 'error'; message: string };

/** Only user-supplied attachments belong to Sources, not tool output images. */
export function collectSessionSources(messages: StreamMessage[]): Attachment[] {
  return mergeSessionSources(messages.flatMap(message =>
    message.type === 'user_prompt' && !message.parentToolUseId ? message.attachments ?? [] : []
  ));
}

export function mergeSessionSources(...groups: Attachment[][]): Attachment[] {
  const sources = new Map<string, Attachment>();
  for (const attachment of groups.flat()) {
    if (!attachment?.path) continue;
    sources.set(attachment.path, attachment);
  }
  return [...sources.values()];
}
