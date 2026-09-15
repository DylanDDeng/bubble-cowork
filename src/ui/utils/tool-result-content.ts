export type ToolOutputPart =
  | { type: 'text' | 'json'; text: string }
  | { type: 'image' | 'audio'; src: string; description?: string }
  | { type: 'resource'; uri: string; name: string; mimeType?: string; text?: string }
  | { type: 'unknown'; text: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? '';
function textPart(text: string): ToolOutputPart {
  try {
    const value = JSON.parse(text);
    if (record(value) || Array.isArray(value)) return { type: 'json', text: json(value) };
  } catch { /* Plain text is the normal fallback. */ }
  return { type: 'text', text };
}

/** Read provider payloads as data. Unknown blocks remain inspectable. */
export function parseToolOutput(content: string, structuredContent?: unknown): ToolOutputPart[] {
  let value: unknown = content;
  try { value = JSON.parse(content); } catch { /* Keep plain text. */ }
  let structured = structuredContent;
  const envelope = record(value) && Array.isArray(value.content);
  if (record(value) && Array.isArray(value.content)) {
    structured ??= value.structuredContent;
    value = value.content;
  }
  let parts: ToolOutputPart[];
  if (Array.isArray(value) && (value.length > 0 || envelope) && value.every(block => record(block) && typeof block.type === 'string')) {
    parts = value.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return textPart(block.text);
      if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string' &&
          typeof block.mimeType === 'string' && /^(image\/(png|jpeg|gif|webp)|audio\/[\w.+-]+)$/.test(block.mimeType) &&
          /^[A-Za-z0-9+/=\s]+$/.test(block.data)) {
        return { type: block.type, src: `data:${block.mimeType};base64,${block.data}` } as ToolOutputPart;
      }
      if (block.type === 'resource_link' && typeof block.uri === 'string') {
        return { type: 'resource', uri: block.uri, name: String(block.title || block.name || block.uri) };
      }
      if ((block.type === 'resource' || block.type === 'embedded_resource') && record(block.resource)) {
        const resource = block.resource;
        return { type: 'resource', uri: String(resource.uri || ''), name: String(resource.uri || 'Resource'),
          mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
          text: typeof resource.text === 'string' ? resource.text : typeof resource.blob === 'string' ? resource.blob : undefined };
      }
      return { type: 'unknown', text: json(block) };
    });
  } else if (typeof value === 'string') {
    parts = value.trim() ? [textPart(value)] : [];
  } else {
    parts = [{ type: 'json', text: json(value) }];
  }
  if (structured != null) {
    const text = json(structured);
    // MCP often repeats structuredContent in its single text block.
    parts = parts.filter(part => !(part.type === 'json' && part.text === text));
    parts.push({ type: 'json', text });
  }
  return parts;
}
