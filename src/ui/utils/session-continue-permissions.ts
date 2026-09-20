import type { SessionContinuePayload } from '../../shared/types';
import type { SessionView } from '../types';
import { loadPreferredBubblePermissionMode } from './bubble-permission';
import { loadPreferredDeepseekPermissionMode } from './deepseek-permission';
import { loadPreferredKimiPermissionMode } from './kimi-permission';
import { loadPreferredQoderPermissionMode } from './qoder-permission';

type ContinuePermissions = Pick<SessionContinuePayload,
  'kimiPermissionMode' | 'grokPermissionMode' | 'qoderPermissionMode' |
  'deepseekPermissionMode' | 'bubblePermissionMode'>;

/**
 * Follow-ups without a mounted chat composer still need its permission
 * preferences. These providers do not persist their permission mode on the
 * session row, so an omitted field can normalize to default in the main
 * process. Claude, Codex and OpenCode already inherit their stored mode.
 * Keep this aligned with useComposerAgentSelection / PromptInput.
 */
export function sessionContinuePermissions(
  session: Pick<SessionView, 'provider' | 'bubblePermissionMode'>,
): ContinuePermissions {
  switch (session.provider) {
    case 'qoder':
      return { qoderPermissionMode: loadPreferredQoderPermissionMode() };
    case 'kimi':
      return { kimiPermissionMode: loadPreferredKimiPermissionMode() };
    case 'grok': {
      const mode = loadPreferredKimiPermissionMode();
      return { kimiPermissionMode: mode, grokPermissionMode: mode };
    }
    case 'deepseek':
      return { deepseekPermissionMode: loadPreferredDeepseekPermissionMode() };
    case 'bubble':
      return { bubblePermissionMode: session.bubblePermissionMode === 'plan'
        ? 'plan' : loadPreferredBubblePermissionMode() };
    default:
      return {};
  }
}
