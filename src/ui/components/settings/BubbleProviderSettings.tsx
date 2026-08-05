import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Eye, EyeOff } from '../icons';
import { BubbleLogo } from '../BubbleLogo';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import grokLogo from '../../assets/grok.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import alibabaLogo from '../../assets/alibaba-color.svg';
import geminiLogo from '../../assets/gemini-color.svg';
import volcengineLogo from '../../assets/volcengine-color.svg';
import stepfunLogo from '../../assets/stepfun.svg';
import type { BubbleProvidersConfig } from '../../types';
import { SettingsGroup, SettingsToggle } from './SettingsPrimitives';

// Brand artwork already bundled for other pickers, keyed by Bubble provider id.
// Providers without artwork fall back to a monogram tile in ProviderLogo.
const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: claudeLogo,
  openai: openaiLogo,
  grok: grokLogo,
  deepseek: deepseekLogo,
  minimax: minimaxLogo,
  'minimax-anthropic': minimaxLogo,
  zhipuai: zhipuLogo,
  'zhipuai-coding-plan': zhipuLogo,
  zai: zhipuLogo,
  'zai-coding-plan': zhipuLogo,
  alibaba: alibabaLogo,
  google: geminiLogo,
  doubao: volcengineLogo,
  stepfun: stepfunLogo,
  'moonshot-cn': moonshotLogo,
  'moonshot-intl': moonshotLogo,
  'kimi-for-coding': moonshotLogo,
};

function ProviderLogo({ providerId, name }: { providerId: string; name: string }) {
  const logo = PROVIDER_LOGOS[providerId];
  if (logo) {
    return <img src={logo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded bg-[var(--bg-tertiary)] text-[9px] font-semibold uppercase text-[var(--text-muted)]"
    >
      {name.charAt(0)}
    </span>
  );
}

// Composer hooks re-fetch Bubble catalogs on this event; fire it after any
// credential change so the model picker updates without a restart.
function notifyBubbleConfigChanged() {
  window.dispatchEvent(new Event('bubble-model-config-updated'));
}

/**
 * API-key management for the bundled Bubble agent. Writes the same
 * ~/.bubble/config.json the Bubble CLI uses, so users never need the CLI to
 * get Bubble running inside Aegis.
 */
export function BubbleProviderSettings() {
  const [config, setConfig] = useState<BubbleProvidersConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // null = "no explicit choice yet": the unconfigured catalog stays collapsed
  // once something is configured, but a brand-new user sees it open.
  const [showAvailable, setShowAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron
      .getBubbleProvidersConfig()
      .then((next) => {
        if (!cancelled) {
          setConfig(next);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyResult = useCallback((next: BubbleProvidersConfig) => {
    setConfig(next);
    notifyBubbleConfigChanged();
  }, []);

  const toggleExpanded = (providerId: string) => {
    setExpandedId((current) => (current === providerId ? null : providerId));
    setKeyDraft('');
    setShowKey(false);
  };

  const saveKey = async (providerId: string) => {
    if (!keyDraft.trim()) {
      toast.error('Enter an API key first.');
      return;
    }
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderKey(providerId, keyDraft));
      setExpandedId(null);
      setKeyDraft('');
      toast.success(`Saved ${providerId} key for Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the key.');
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.removeBubbleProvider(providerId));
      setExpandedId(null);
      toast.success(`Removed ${providerId} from Bubble.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (providerId: string) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleDefaultProvider(providerId));
      toast.success(`${providerId} is now Bubble's default provider.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set the default provider.');
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (providerId: string, enabled: boolean) => {
    setBusyId(providerId);
    try {
      applyResult(await window.electron.setBubbleProviderEnabled(providerId, enabled));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to toggle the provider.');
    } finally {
      setBusyId(null);
    }
  };

  const providers = config?.providers || [];

  // Prefill the editor with the stored key when one exists, so the user sees
  // it masked (dots) and can reveal it with the eye toggle — the usual
  // "saved credential" pattern. Fetched on demand; the bulk config never
  // carries keys.
  useEffect(() => {
    if (!expandedId) return;
    const provider = providers.find((entry) => entry.id === expandedId);
    if (!provider?.hasApiKey) return;
    let cancelled = false;
    window.electron
      .getBubbleProviderKey(expandedId)
      .then((key) => {
        if (!cancelled && key) setKeyDraft(key);
      })
      .catch(() => {
        // Leave the draft empty; the user can still type a replacement key.
      });
    return () => {
      cancelled = true;
    };
    // Only refetch when a different editor opens — refetching on config
    // changes (e.g. toggling another provider) would clobber an in-progress
    // edit with the stored key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedId]);
  const configuredProviders = providers.filter((provider) => provider.configured);
  const availableProviders = providers.filter((provider) => !provider.configured);
  const availableVisible = showAvailable ?? configuredProviders.length === 0;

  const renderRow = (provider: (typeof providers)[number]) => {
    const expanded = expandedId === provider.id;
    const busy = busyId === provider.id;
    return (
      <div key={provider.id} className="px-4 py-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div
            className={`flex min-w-0 items-center gap-2.5 ${provider.configured && !provider.enabled ? 'opacity-50' : ''}`}
          >
            <ProviderLogo providerId={provider.id} name={provider.name} />
            <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
              <span className="truncate">{provider.name}</span>
              {provider.isDefault ? (
                <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Default
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {provider.configured && provider.hasApiKey && provider.enabled && !provider.isDefault ? (
              <button
                type="button"
                onClick={() => void makeDefault(provider.id)}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
              >
                Make default
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => toggleExpanded(provider.id)}
              disabled={busy}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              <span>{provider.hasApiKey ? 'Edit key' : 'Add key'}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
            {provider.configured ? (
              <SettingsToggle
                checked={provider.enabled}
                onChange={(value) => void setEnabled(provider.id, value)}
                disabled={busy}
                ariaLabel={`Enable ${provider.name} for Bubble`}
              />
            ) : null}
          </div>
        </div>

        {expanded ? (
          <div className="mt-3 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey(provider.id);
                }}
                placeholder={provider.hasApiKey ? 'Enter a new API key to replace' : 'sk-...'}
                autoFocus
                disabled={busy}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] py-1.5 pl-3 pr-8 font-mono text-[12px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-muted)] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowKey((current) => !current)}
                className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                aria-label={showKey ? 'Hide key' : 'Show key'}
                disabled={busy}
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void saveKey(provider.id)}
              disabled={busy || !keyDraft.trim()}
              className="rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            {provider.configured ? (
              <button
                type="button"
                onClick={() => void removeProvider(provider.id)}
                disabled={busy}
                className="rounded-lg px-2 py-1.5 text-[12px] font-medium text-red-500 transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <SettingsGroup
      title="Bubble providers"
      description="API keys for the bundled Bubble agent — no Bubble CLI needed. Stored in ~/.bubble/config.json, shared with the Bubble CLI."
    >
      {loadError ? (
        <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">
          Could not load Bubble provider config: {loadError}
        </div>
      ) : !config ? (
        <div className="px-4 py-3 text-[13px] text-[var(--text-muted)]">Loading…</div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-4 py-3">
            <BubbleLogo className="h-4 w-4" />
            <span className="text-[12px] text-[var(--text-muted)]">
              {configuredProviders.length > 0
                ? `${configuredProviders.filter((provider) => provider.enabled).length} of ${configuredProviders.length} configured provider(s) enabled`
                : 'No providers configured yet — add a key below to start using Bubble.'}
            </span>
          </div>
          {configuredProviders.map(renderRow)}
          {availableProviders.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowAvailable(!availableVisible)}
              aria-expanded={availableVisible}
              className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[12px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${availableVisible ? 'rotate-180' : ''}`}
              />
              <span>
                {availableVisible
                  ? 'Hide available providers'
                  : `Add another provider (${availableProviders.length} available)`}
              </span>
            </button>
          ) : null}
          {availableVisible ? availableProviders.map(renderRow) : null}
        </>
      )}
    </SettingsGroup>
  );
}
