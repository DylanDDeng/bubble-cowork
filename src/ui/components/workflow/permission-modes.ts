import { loadPreferredBubblePermissionMode } from '../../utils/bubble-permission';
import { loadPreferredClaudePermissionMode } from '../../utils/claude-permission';
import { loadPreferredCodexPermissionMode } from '../../utils/codex-permission';
import { loadPreferredDeepseekPermissionMode } from '../../utils/deepseek-permission';
import { loadPreferredDevinPermissionMode } from '../../utils/devin-permission';
import { loadPreferredKimiPermissionMode } from '../../utils/kimi-permission';
import { loadPreferredMimoPermissionMode } from '../../utils/mimo-permission';
import { loadPreferredOpencodePermissionMode } from '../../utils/opencode-permission';
import { loadPreferredQoderPermissionMode } from '../../utils/qoder-permission';

/** Composer permission preferences per provider, resolved here because they live in this renderer's storage. */
export function composerPermissionModes(): Record<string, string> {
  const modes: Record<string, string> = {
    claude: loadPreferredClaudePermissionMode(),
    codex: loadPreferredCodexPermissionMode(),
    kimi: loadPreferredKimiPermissionMode(),
    grok: loadPreferredKimiPermissionMode(),
    opencode: loadPreferredOpencodePermissionMode(),
    qoder: loadPreferredQoderPermissionMode(),
    deepseek: loadPreferredDeepseekPermissionMode(),
    devin: loadPreferredDevinPermissionMode(),
    mimo: loadPreferredMimoPermissionMode(),
    bubble: loadPreferredBubblePermissionMode(),
  };
  // Plan mode is not a permission level for someone who must write code.
  return Object.fromEntries(Object.entries(modes).filter(([, mode]) => mode && mode !== 'plan'));
}

/** Hand the current preferences to the main process for workflows started from a chat. */
export function syncWorkflowDefaults(): void {
  try {
    void window.electron?.workflows?.setDefaults({ permissionModes: composerPermissionModes() }).catch(() => {});
  } catch {
    // Preferences are best effort; workflows fall back to each provider's default.
  }
}
