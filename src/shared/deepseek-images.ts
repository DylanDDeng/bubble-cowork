import type { Attachment, DeepseekModelConfig } from './types';

export const DEEPSEEK_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type DeepseekImageMimeType = typeof DEEPSEEK_IMAGE_MIME_TYPES[number];

export function deepseekImageInputError(
  attachments: Attachment[] | undefined,
  model: string | null | undefined,
  config: DeepseekModelConfig,
): string | null {
  if (!attachments?.some((attachment) => attachment.kind === 'image')) return null;
  const effectiveModel = model?.trim() || config.defaultModel;
  if (effectiveModel && config.imageModels?.includes(effectiveModel)) return null;
  const suggestion = config.imageModels?.length
    ? `Switch to ${config.imageModels.join(' or ')} to send images.`
    : 'Select an image-capable model in the DeepSeek runtime profile.';
  return `${effectiveModel || 'The selected DeepSeek model'} does not support image input. ${suggestion}`;
}
