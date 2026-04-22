import type { Attachment } from '../types';
import { hasProjectFileMentions } from './project-file-mentions';

export const LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD = 500;
const LONG_PROMPT_ATTACHMENT_INSTRUCTION =
  'The main request is attached as a text file. Read the attachment first, then respond normally.';

export async function maybeConvertLongPromptToAttachment(params: {
  cwd?: string | null;
  prompt: string;
  attachments: Attachment[];
}): Promise<{
  prompt: string;
  attachments: Attachment[];
  converted: boolean;
  attachmentName?: string;
  reason?: 'too_short' | 'missing_cwd' | 'attachment_create_failed' | 'has_project_mentions';
}> {
  const prompt = params.prompt.trim();
  if (!prompt || prompt.length <= LONG_PROMPT_AUTO_ATTACHMENT_THRESHOLD) {
    return {
      prompt,
      attachments: params.attachments,
      converted: false,
      reason: 'too_short',
    };
  }

  if (hasProjectFileMentions(prompt)) {
    return {
      prompt,
      attachments: params.attachments,
      converted: false,
      reason: 'has_project_mentions',
    };
  }

  const cwd = params.cwd?.trim();
  if (!cwd) {
    return {
      prompt,
      attachments: params.attachments,
      converted: false,
      reason: 'missing_cwd',
    };
  }

  const attachment = await window.electron.createInlineTextAttachment(cwd, prompt);
  if (!attachment) {
    return {
      prompt,
      attachments: params.attachments,
      converted: false,
      reason: 'attachment_create_failed',
    };
  }

  return {
    prompt: LONG_PROMPT_ATTACHMENT_INSTRUCTION,
    attachments: [...params.attachments, attachment],
    converted: true,
    attachmentName: attachment.name,
  };
}
