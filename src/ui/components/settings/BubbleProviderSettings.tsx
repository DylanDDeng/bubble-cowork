import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown } from '../icons';
import { OpenCodeLogo } from '../OpenCodeLogo';
import claudeLogo from '../../assets/claude-color.svg';
import openaiLogo from '../../assets/openai.svg';
import moonshotLogo from '../../assets/moonshot.svg';
import grokLogo from '../../assets/grok.svg';
import deepseekLogo from '../../assets/deepseek-color.svg';
import minimaxLogo from '../../assets/minimax-color.svg';
import zhipuLogo from '../../assets/zhipu-color.svg';
import alibabaLogo from '../../assets/alibaba-color.svg';
import bailianLogo from '../../assets/bailian-color.svg';
import fireworksLogo from '../../assets/fireworks-color.svg';
import geminiLogo from '../../assets/gemini-color.svg';
import volcengineLogo from '../../assets/volcengine-color.svg';
import stepfunLogo from '../../assets/stepfun.svg';
import type { BubbleProvidersConfig } from '../../types';
import { ProviderKeyEditor, ProviderSettingsRow, ProviderSettingsSection } from './ProviderSettingsPrimitives';

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
  'bailian-token-plan': bailianLogo,
  fireworks: fireworksLogo,
  google: geminiLogo,
  doubao: volcengineLogo,
  stepfun: stepfunLogo,
  'moonshot-cn': moonshotLogo,
  'moonshot-intl': moonshotLogo,
  'kimi-for-coding': moonshotLogo,
};

function ProviderLogo({ providerId, name }: { providerId: string; name: string }) {
  // OpenCode's mark is theme-dependent, so it comes from the shared component
  // rather than the static map.
  if (providerId === 'opencode-zen') return <OpenCodeLogo />;
  const logo = PROVIDER_LOGOS[providerId];
  if (logo) {
    return <img src={logo} alt="" className={`h-4 w-4 flex-shrink-0 ${[claudeLogo, openaiLogo, grokLogo, moonshotLogo, stepfunLogo].includes(logo) ? 'provider-monochrome-logo' : ''}`} aria-hidden="true" />;
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
export function BubbleProviderSettings({ revealTarget }: { revealTarget?: string } = {}) {
  const [config, setConfig] = useState<BubbleProvidersConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [showKey, setShowKey] = useState(false);
  const keyEdited = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
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
  }, [loadAttempt]);

  const applyResult = useCallback((next: BubbleProvidersConfig) => {
    setConfig(next);
    notifyBubbleConfigChanged();
  }, []);

  const toggleExpanded = (providerId: string) => {
    setExpandedId((current) => (current === providerId ? null : providerId));
    setKeyDraft('');
    keyEdited.current = false;
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
        if (!cancelled && !keyEdited.current && key) setKeyDraft(key);
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

  useEffect(() => {
    if (revealTarget?.startsWith('Bubble:')) setShowAvailable(true);
  }, [revealTarget]);

  const renderRow = (provider: (typeof providers)[number]) => {
    const actions = [
      ...(provider.configured && provider.hasApiKey && provider.enabled && !provider.isDefault ? [{ label: 'Make default', onSelect: () => void makeDefault(provider.id) }] : []),
      ...(provider.configured ? [{ label: 'Remove provider', onSelect: () => void removeProvider(provider.id), destructive: true }] : []),
    ];
    return <ProviderSettingsRow key={provider.id} label={provider.name} scope="Bubble" logo={<ProviderLogo providerId={provider.id} name={provider.name} />}
      expanded={expandedId === provider.id} disabled={busyId !== null} isDefault={provider.isDefault}
      status={!provider.hasApiKey ? 'No API key' : !provider.enabled ? 'Disabled' : undefined}
      enabled={provider.enabled} onToggleEnabled={provider.configured ? value => void setEnabled(provider.id, value) : undefined}
      onToggleExpand={() => toggleExpanded(provider.id)} actions={actions}>
      <ProviderKeyEditor label={`${provider.name} API key for Bubble`} value={keyDraft} onChange={value => { keyEdited.current = true; setKeyDraft(value); }} showKey={showKey} onToggleVisibility={() => setShowKey(value => !value)} busy={busyId !== null} onSave={() => void saveKey(provider.id)} onCancel={() => toggleExpanded(provider.id)} />
    </ProviderSettingsRow>;
  };
  return <ProviderSettingsSection title="Bubble">
    {loadError ? <div className="provider-load-message" role="alert">Could not load providers. <button onClick={() => { setLoadError(null); setLoadAttempt(value => value + 1); }}>Retry</button></div>
      : !config ? <div className="provider-load-message" role="status">Loading…</div>
      : <>
        {configuredProviders.map(renderRow)}
        {availableProviders.length > 0 && <button type="button" className="provider-add-button" onClick={() => setShowAvailable(!availableVisible)} aria-expanded={availableVisible}>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${availableVisible ? 'rotate-180' : ''}`} />{availableVisible ? 'Hide available providers' : 'Add provider'}
        </button>}
        {availableVisible && availableProviders.map(renderRow)}
      </>}
  </ProviderSettingsSection>;
}
