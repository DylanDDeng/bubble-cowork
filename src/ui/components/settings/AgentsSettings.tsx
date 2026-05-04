import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  Palette,
  PlugZap,
  Plus,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { AgentModelPicker } from '../AgentModelPicker';
import { AgentAvatar, AGENT_AVATAR_OPTIONS } from '../AgentAvatar';
import { useAppStore } from '../../store/useAppStore';
import type {
  AegisBuiltInAgentConfig,
  AgentPermissionPolicy,
  AgentProfile,
  AgentProfileColor,
  AgentAvatarAssetKey,
  ClaudeCompatibleProviderId,
  AgentReasoningEffort,
} from '../../types';
import { useClaudeModelConfig } from '../../hooks/useClaudeModelConfig';
import { useCodexModelConfig } from '../../hooks/useCodexModelConfig';
import { useCompatibleProviderConfig } from '../../hooks/useCompatibleProviderConfig';
import { useOpencodeModelConfig } from '../../hooks/useOpencodeModelConfig';
import {
  buildClaudeModelOptions,
  canonicalizeClaudeModel,
  isOfficialClaudeModel,
} from '../../utils/claude-model';
import { buildCodexModelOptions, resolveCodexModel } from '../../utils/codex-model';
import { buildOpencodeModelOptions } from '../../utils/opencode-model';
import {
  AEGIS_BUILT_IN_PROVIDERS,
  getAegisBuiltInProvider,
  listAegisBuiltInModels,
  resolveAegisBuiltInModel,
} from '../../../shared/aegis-built-in-catalog';
import { SettingsGroup, SettingsToggle } from './SettingsPrimitives';

const AGENT_COLORS: Array<{ value: AgentProfileColor; label: string }> = [
  { value: 'amber', label: 'Amber' },
  { value: 'sky', label: 'Sky' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'violet', label: 'Violet' },
  { value: 'rose', label: 'Rose' },
  { value: 'slate', label: 'Slate' },
];

const FIELD_CONTROL_CLASS =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]';

const TEXTAREA_CONTROL_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[12.5px] leading-5 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)] min-h-[76px] resize-y';

const CLAUDE_REASONING_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const CODEX_REASONING_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const AEGIS_REASONING_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

function isAegisDeepSeekV4Model(model?: string | null): boolean {
  const selection = resolveAegisBuiltInModel(model);
  return (
    selection.providerId === 'deepseek' &&
    (selection.modelId === 'deepseek-v4-flash' || selection.modelId === 'deepseek-v4-pro')
  );
}

function displayName(profile: AgentProfile): string {
  return profile.name.trim() || 'Untitled agent';
}

function displayRole(profile: AgentProfile): string {
  return profile.role.trim() || 'Agent';
}

function displayProvider(profile: AgentProfile): string {
  if (profile.provider === 'aegis') return 'Aegis Built-in';
  if (profile.provider === 'claude') return 'Claude';
  if (profile.provider === 'codex') return 'Codex';
  return 'OpenCode';
}

function displayModel(profile: AgentProfile): string {
  const model = profile.model?.trim();
  if (!model) return 'Default';
  if (profile.provider !== 'aegis') return model;
  const selection = resolveAegisBuiltInModel(model);
  const resolved = listAegisBuiltInModels(selection.providerId).find(
    (candidate) => candidate.id === selection.modelId
  );
  return resolved?.name || selection.modelId;
}

function displayPermissionPolicy(policy: AgentPermissionPolicy): string {
  if (policy === 'readOnly') return 'Read only';
  if (policy === 'fullAccess') return 'Full access';
  return 'Ask';
}

function getAegisProviderApiKey(config: AegisBuiltInAgentConfig, providerId: string): string {
  return config.providerApiKeys?.[providerId] || (config.providerId === providerId ? config.apiKey : '');
}

function setAegisProviderApiKey(
  config: AegisBuiltInAgentConfig,
  providerId: string,
  apiKey: string
): AegisBuiltInAgentConfig {
  const providerApiKeys = { ...(config.providerApiKeys || {}) };
  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey) {
    providerApiKeys[providerId] = normalizedApiKey;
  } else {
    delete providerApiKeys[providerId];
  }
  return {
    ...config,
    apiKey,
    providerApiKeys,
  };
}

function buildAegisApiKeyDrafts(config: AegisBuiltInAgentConfig): Record<string, string> {
  const providerApiKeys = { ...(config.providerApiKeys || {}) };
  if (config.apiKey && !providerApiKeys[config.providerId]) {
    providerApiKeys[config.providerId] = config.apiKey;
  }
  return providerApiKeys;
}

function readAegisApiKeyDraft(
  drafts: Record<string, string>,
  config: AegisBuiltInAgentConfig | null,
  providerId: string | null
): string {
  if (!providerId) {
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(drafts, providerId)) {
    return drafts[providerId];
  }
  return config ? getAegisProviderApiKey(config, providerId) : '';
}

export function AgentsSettingsContent() {
  const {
    agentProfiles,
    createAgentProfile,
    updateAgentProfile,
    deleteAgentProfile,
    setAgentSetupOpen,
  } = useAppStore();
  const profiles = useMemo(
    () => Object.values(agentProfiles).sort((left, right) => left.createdAt - right.createdAt),
    [agentProfiles]
  );
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const selectedProfile = selectedProfileId ? agentProfiles[selectedProfileId] || null : null;

  useEffect(() => {
    if (profiles.length === 0) {
      if (selectedProfileId) {
        setSelectedProfileId('');
      }
      return;
    }
    if (selectedProfileId && !agentProfiles[selectedProfileId]) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [agentProfiles, profiles, selectedProfileId]);

  const handleCreateProfile = () => {
    const profileId = createAgentProfile();
    setSelectedProfileId(profileId);
  };

  const handleDeleteProfile = (profileId: string) => {
    const profile = agentProfiles[profileId];
    if (!profile) return;
    const confirmed = window.confirm(`Delete agent profile "${displayName(profile)}"?`);
    if (!confirmed) return;
    const nextProfile = profiles.find((candidate) => candidate.id !== profileId);
    deleteAgentProfile(profileId);
    setSelectedProfileId(nextProfile?.id || '');
  };

  return (
    <div className="space-y-6 pb-8">
      <SettingsGroup>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
              <PlugZap className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
              <span>Setup agents</span>
            </div>
            <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
              Check local runtimes and create a profile.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAgentSetupOpen(true)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors ${
              profiles.length === 0
                ? 'bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90'
                : 'border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            Run setup
          </button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[var(--text-primary)]">Profiles</div>
            <div className="mt-0.5 flex items-center gap-2 text-[12px] leading-5 text-[var(--text-muted)]">
              <span>Reusable agents for DMs and project rosters.</span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--bg-secondary)] px-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
                {profiles.length}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCreateProfile}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </div>

        {profiles.length === 0 ? (
          <button
            type="button"
            onClick={handleCreateProfile}
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-[var(--border)] text-[var(--text-muted)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--text-primary)]">New agent profile</span>
              <span className="mt-0.5 block text-[12px] leading-5 text-[var(--text-muted)]">
                Choose identity, runtime, model, and permissions.
              </span>
            </span>
            <span className="inline-flex h-8 items-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)]">
              Create
            </span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleCreateProfile}
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-[var(--border)] text-[var(--text-muted)]">
                <Plus className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--text-primary)]">New agent profile</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-[var(--text-muted)]">
                  Choose identity, runtime, model, and permissions.
                </span>
              </span>
              <span className="inline-flex h-8 items-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)]">
                Create
              </span>
            </button>
            {profiles.map((profile) => (
              <AgentProfileRow
                key={profile.id}
                profile={profile}
                expanded={selectedProfile?.id === profile.id}
                onToggleExpand={() =>
                  setSelectedProfileId((current) => current === profile.id ? '' : profile.id)
                }
                onUpdate={(patch) => updateAgentProfile(profile.id, patch)}
                onDelete={() => handleDeleteProfile(profile.id)}
              />
            ))}
          </>
        )}
      </SettingsGroup>
    </div>
  );
}

function AgentProfileRow({
  profile,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
}: {
  profile: AgentProfile;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (patch: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>) => void;
  onDelete: () => void;
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggleExpand();
    }
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggleExpand}
        onKeyDown={handleKeyDown}
        className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-secondary)]/60"
      >
        <AgentAvatar profile={profile} size="md" decorative />
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
            {displayName(profile)}
          </span>
          <span className="truncate text-[12px] text-[var(--text-muted)]">{displayRole(profile)}</span>
          {expanded ? (
            <span className="inline-flex h-5 flex-shrink-0 items-center rounded-md bg-emerald-500/10 px-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              Active
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 items-center gap-2 lg:flex">
            <SummaryChip>{displayProvider(profile)}</SummaryChip>
            <SummaryChip className="max-w-[136px]">{displayModel(profile)}</SummaryChip>
            <SummaryChip>{displayPermissionPolicy(profile.permissionPolicy)}</SummaryChip>
          </div>
          <div
            className="flex items-center gap-2"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            role="presentation"
          >
            <span className="hidden text-[12px] text-[var(--text-muted)] xl:inline">Enabled</span>
            <SettingsToggle
              checked={profile.enabled}
              onChange={(enabled) => onUpdate({ enabled })}
              ariaLabel={profile.enabled ? `Disable ${displayName(profile)}` : `Enable ${displayName(profile)}`}
            />
          </div>
          <ChevronDown
            className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3">
          <AgentProfileForm
            profile={profile}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        </div>
      ) : null}
    </div>
  );
}

function SummaryChip({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-7 min-w-[76px] items-center justify-center truncate rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12px] text-[var(--text-secondary)] ${className}`}
      title={typeof children === 'string' ? children : undefined}
    >
      {children}
    </span>
  );
}

function resolveCompatibleProviderId(
  model: string | null | undefined,
  compatibleProviderId: ClaudeCompatibleProviderId | null | undefined,
  compatibleOptions: Array<{ id: ClaudeCompatibleProviderId; model: string }>
): ClaudeCompatibleProviderId | undefined {
  const normalizedModel = model?.trim();
  if (!normalizedModel) {
    return undefined;
  }

  const matchingOptions = compatibleOptions.filter((option) => option.model === normalizedModel);
  if (matchingOptions.length === 0) {
    return undefined;
  }

  if (compatibleProviderId) {
    const exactMatch = matchingOptions.find((option) => option.id === compatibleProviderId);
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  return matchingOptions[0]?.id;
}

function AgentProfileForm({
  profile,
  onUpdate,
  onDelete,
}: {
  profile: AgentProfile;
  onUpdate: (patch: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>) => void;
  onDelete: () => void;
}) {
  const claudeModelConfig = useClaudeModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const codexModelConfig = useCodexModelConfig();
  const codexModelOptions = useMemo(
    () => buildCodexModelOptions(codexModelConfig),
    [codexModelConfig]
  );
  const opencodeModelConfig = useOpencodeModelConfig();
  const opencodeModelOptions = useMemo(
    () => buildOpencodeModelOptions(opencodeModelConfig),
    [opencodeModelConfig]
  );
  const claudeModelOptions = useMemo(
    () => buildClaudeModelOptions(claudeModelConfig),
    [claudeModelConfig]
  );
  const [aegisConfig, setAegisConfig] = useState<AegisBuiltInAgentConfig | null>(null);
  const [aegisApiKeyDrafts, setAegisApiKeyDrafts] = useState<Record<string, string>>({});
  const [showAegisApiKey, setShowAegisApiKey] = useState(false);
  const [savingAegisApiKey, setSavingAegisApiKey] = useState(false);

  const resolveProfileModelSelection = (
    provider: AgentProfile['provider'],
    preferredModel?: string | null,
    preferredCompatibleProviderId?: ClaudeCompatibleProviderId | null
  ): { model?: string; compatibleProviderId?: ClaudeCompatibleProviderId } => {
    const normalizedModel = preferredModel?.trim() || undefined;

    if (provider === 'claude') {
      const normalizedClaudeModel = canonicalizeClaudeModel(normalizedModel);
      if (normalizedClaudeModel) {
        const compatibleProviderId = resolveCompatibleProviderId(
          normalizedClaudeModel,
          preferredCompatibleProviderId,
          compatibleOptions
        );
        if (compatibleProviderId) {
          return { model: normalizedClaudeModel, compatibleProviderId };
        }
        if (isOfficialClaudeModel(normalizedClaudeModel)) {
          return { model: normalizedClaudeModel };
        }
      }

      const defaultModel = canonicalizeClaudeModel(claudeModelConfig.defaultModel);
      return { model: defaultModel || claudeModelOptions[0] || undefined };
    }

    if (provider === 'codex') {
      const model = normalizedModel
        ? resolveCodexModel(normalizedModel, codexModelConfig)
        : resolveCodexModel(null, codexModelConfig);
      return { model: model || undefined };
    }

    if (provider === 'aegis') {
      return { model: resolveAegisBuiltInModel(normalizedModel).encoded };
    }

    if (normalizedModel && (opencodeModelOptions.length === 0 || opencodeModelOptions.includes(normalizedModel))) {
      return { model: normalizedModel };
    }

    return { model: opencodeModelOptions[0] || undefined };
  };

  const selectedModel = useMemo(
    () =>
      resolveProfileModelSelection(
        profile.provider,
        profile.model,
        profile.compatibleProviderId
      ),
    [
      claudeModelConfig,
      claudeModelOptions,
      codexModelConfig,
      compatibleOptions,
      opencodeModelOptions,
      profile.compatibleProviderId,
      profile.model,
      profile.provider,
    ]
  );

  useEffect(() => {
    if (profile.provider !== 'aegis') {
      return;
    }
    let cancelled = false;
    window.electron
      .getAegisBuiltInAgentConfig()
      .then((config) => {
        if (cancelled) return;
        setAegisConfig(config);
        setAegisApiKeyDrafts(buildAegisApiKeyDrafts(config));
      })
      .catch((error) => {
        console.error('Failed to load Aegis Built-in Agent config:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.provider]);

  const selectedAegisProviderId = profile.provider === 'aegis'
    ? resolveAegisBuiltInModel(selectedModel.model || aegisConfig?.model, aegisConfig?.providerId).providerId
    : null;
  const aegisApiKeyDraft = readAegisApiKeyDraft(aegisApiKeyDrafts, aegisConfig, selectedAegisProviderId);

  const handleSaveAegisApiKey = async () => {
    if (profile.provider !== 'aegis') {
      return;
    }
    setSavingAegisApiKey(true);
    try {
      const currentConfig = aegisConfig || (await window.electron.getAegisBuiltInAgentConfig());
      const selection = resolveAegisBuiltInModel(selectedModel.model || currentConfig.model, currentConfig.providerId);
      const provider = getAegisBuiltInProvider(selection.providerId);
      const saved = await window.electron.saveAegisBuiltInAgentConfig({
        ...currentConfig,
        providerId: selection.providerId,
        baseUrl: provider?.baseUrl || currentConfig.baseUrl,
        model: selection.encoded,
        apiKey: aegisApiKeyDraft.trim(),
        providerApiKeys: setAegisProviderApiKey(currentConfig, selection.providerId, aegisApiKeyDraft).providerApiKeys,
      });
      setAegisConfig(saved);
      setAegisApiKeyDrafts((current) => ({
        ...buildAegisApiKeyDrafts(saved),
        ...current,
        [selection.providerId]: getAegisProviderApiKey(saved, selection.providerId),
      }));
      window.dispatchEvent(new CustomEvent('aegis-built-in-agent-config-updated'));
      toast.success('Aegis Built-in API key saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Aegis Built-in API key.');
    } finally {
      setSavingAegisApiKey(false);
    }
  };

  const aegisApiKeyDirty = profile.provider === 'aegis' && aegisApiKeyDraft !== (
    selectedAegisProviderId && aegisConfig
      ? getAegisProviderApiKey(aegisConfig, selectedAegisProviderId)
      : ''
  );

  useEffect(() => {
    const currentModel = profile.model?.trim() || undefined;
    const patch: Partial<Omit<AgentProfile, 'id' | 'createdAt'>> = {};
    if (selectedModel.model && selectedModel.model !== currentModel) {
      patch.model = selectedModel.model;
    }
    if (profile.provider === 'claude') {
      if (selectedModel.compatibleProviderId !== profile.compatibleProviderId) {
        patch.compatibleProviderId = selectedModel.compatibleProviderId;
      }
    } else if (profile.compatibleProviderId) {
      patch.compatibleProviderId = undefined;
    }

    if (Object.keys(patch).length > 0) {
      onUpdate(patch);
    }
  }, [
    onUpdate,
    profile.compatibleProviderId,
    profile.model,
    profile.provider,
    selectedModel.compatibleProviderId,
    selectedModel.model,
  ]);

  const handleProviderChange = (provider: AgentProfile['provider']) => {
    const nextSelection = resolveProfileModelSelection(provider);
    onUpdate({
      provider,
      model: nextSelection.model,
      compatibleProviderId:
        provider === 'claude' ? nextSelection.compatibleProviderId : undefined,
      reasoningEffort:
        provider === 'opencode' || (provider === 'codex' && profile.reasoningEffort === 'max')
          ? undefined
          : provider === 'aegis'
            ? isAegisDeepSeekV4Model(nextSelection.model)
              ? profile.reasoningEffort === 'max' ? 'max' : 'high'
              : undefined
          : profile.reasoningEffort,
    });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]">
      <div className="grid min-h-[300px] lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <FormSection title="Identity" icon={<User className="h-3.5 w-3.5" />}>
          <FormField label="Avatar">
            <AvatarPicker
              profile={profile}
              onChange={(key) => onUpdate({ avatar: { type: 'asset', key } })}
            />
          </FormField>

          <FormField label="Name">
            <input
              value={profile.name}
              onChange={(event) => onUpdate({ name: event.target.value })}
              className={FIELD_CONTROL_CLASS}
            />
          </FormField>
          <FormField label="Role">
            <input
              value={profile.role}
              onChange={(event) => onUpdate({ role: event.target.value })}
              className={FIELD_CONTROL_CLASS}
            />
          </FormField>

          <FormField label="Description">
            <textarea
              value={profile.description}
              onChange={(event) => onUpdate({ description: event.target.value })}
              rows={3}
              className={TEXTAREA_CONTROL_CLASS}
            />
          </FormField>
          <FormField label="Instructions">
            <textarea
              value={profile.instructions}
              onChange={(event) => onUpdate({ instructions: event.target.value })}
              rows={5}
              className={TEXTAREA_CONTROL_CLASS}
            />
          </FormField>
        </FormSection>

        <FormSection
          title="Runtime"
          icon={<Code2 className="h-3.5 w-3.5" />}
          className="border-t border-[var(--border)] lg:border-l lg:border-t-0"
        >
        <div className="space-y-3">
          <FormField label="Provider">
            <select
              value={profile.provider}
              onChange={(event) => handleProviderChange(event.target.value as AgentProfile['provider'])}
              className={FIELD_CONTROL_CLASS}
            >
              <option value="aegis">Aegis Built-in</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </FormField>
          <FormField label="Model">
            {profile.provider === 'aegis' ? (
              <select
                value={selectedModel.model || ''}
                onChange={(event) => {
                  const model = resolveAegisBuiltInModel(event.target.value).encoded;
                  onUpdate({
                    model,
                    reasoningEffort: isAegisDeepSeekV4Model(model)
                      ? profile.reasoningEffort === 'max' ? 'max' : 'high'
                      : undefined,
                  });
                }}
                className={FIELD_CONTROL_CLASS}
              >
                {AEGIS_BUILT_IN_PROVIDERS.map((provider) => {
                  const models = listAegisBuiltInModels(provider.id);
                  if (models.length === 0) {
                    return null;
                  }
                  return (
                    <optgroup key={provider.id} label={provider.name}>
                      {models.map((model) => (
                        <option key={`${provider.id}:${model.id}`} value={`${provider.id}:${model.id}`}>
                          {model.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            ) : (
              <AgentModelPicker
                provider={profile.provider}
                onProviderChange={handleProviderChange}
                menuPlacement="bottom"
                menuStrategy="fixed"
                triggerClassName="h-8 w-full justify-between rounded-md border-[var(--border)] bg-[var(--bg-primary)] px-2.5 hover:bg-[var(--bg-tertiary)]"
                claudeModel={{
                  value: selectedModel.model || null,
                  compatibleProviderId: selectedModel.compatibleProviderId || null,
                  config: claudeModelConfig,
                  compatibleOptions,
                  onChange: (model, compatibleProviderId) => {
                    onUpdate({
                      model,
                      compatibleProviderId: compatibleProviderId || undefined,
                    });
                  },
                }}
                codexModel={{
                  value: selectedModel.model || null,
                  options: codexModelOptions,
                  onChange: (model) => onUpdate({ model }),
                }}
                opencodeModel={{
                  value: selectedModel.model || null,
                  options: opencodeModelOptions,
                  onChange: (model) => onUpdate({ model }),
                }}
              />
            )}
          </FormField>
        </div>

        {profile.provider === 'aegis' ? (
          <FormField label="API key">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  type={showAegisApiKey ? 'text' : 'password'}
                  value={aegisApiKeyDraft}
                  onChange={(event) => {
                    if (!selectedAegisProviderId) {
                      return;
                    }
                    const nextValue = event.target.value;
                    setAegisApiKeyDrafts((current) => ({
                      ...current,
                      [selectedAegisProviderId]: nextValue,
                    }));
                  }}
                  placeholder="Provider API key"
                  className={`${FIELD_CONTROL_CLASS} pr-8`}
                  disabled={savingAegisApiKey}
                />
                <button
                  type="button"
                  onClick={() => setShowAegisApiKey((current) => !current)}
                  className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  aria-label={showAegisApiKey ? 'Hide API key' : 'Show API key'}
                  disabled={savingAegisApiKey}
                >
                  {showAegisApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleSaveAegisApiKey()}
                disabled={savingAegisApiKey || !aegisApiKeyDirty}
                className="inline-flex h-8 flex-shrink-0 items-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingAegisApiKey ? 'Saving...' : 'Save key'}
              </button>
            </div>
          </FormField>
        ) : null}

        {profile.provider === 'claude' || profile.provider === 'codex' || (profile.provider === 'aegis' && isAegisDeepSeekV4Model(selectedModel.model)) ? (
          <FormField label="Reasoning">
            <select
              value={profile.provider === 'aegis' ? profile.reasoningEffort || 'high' : profile.reasoningEffort || ''}
              onChange={(event) => (
                onUpdate({ reasoningEffort: event.target.value ? event.target.value as AgentReasoningEffort : undefined })
              )}
              className={FIELD_CONTROL_CLASS}
            >
              {profile.provider === 'aegis' ? null : <option value="">Default</option>}
              {(profile.provider === 'aegis'
                ? AEGIS_REASONING_OPTIONS
                : profile.provider === 'codex'
                  ? CODEX_REASONING_OPTIONS
                  : CLAUDE_REASONING_OPTIONS
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        <FormField label="Permission policy">
          <select
            value={profile.permissionPolicy}
            onChange={(event) => (
              onUpdate({ permissionPolicy: event.target.value as AgentPermissionPolicy })
            )}
            className={FIELD_CONTROL_CLASS}
          >
            <option value="ask">Ask</option>
            <option value="readOnly">Read only</option>
            <option value="fullAccess">Full access</option>
          </select>
        </FormField>

        <FormField label="Color">
          <div className="relative">
            <select
              value={profile.color}
              onChange={(event) => onUpdate({ color: event.target.value as AgentProfileColor })}
              className={`${FIELD_CONTROL_CLASS} pl-8`}
            >
              {AGENT_COLORS.map((color) => (
                <option key={color.value} value={color.value}>
                  {color.label}
                </option>
              ))}
            </select>
            <Palette className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          </div>
        </FormField>
        <FormField label="Can delegate">
          <div className="grid min-h-8 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <SettingsToggle
              checked={profile.canDelegate === true}
              onChange={(canDelegate) => onUpdate({ canDelegate })}
              ariaLabel="Allow agent delegation"
            />
            <div className="text-[11.5px] leading-4 text-[var(--text-muted)]">
              Allow this agent to delegate work to others.
            </div>
          </div>
        </FormField>
        </FormSection>
      </div>

      <div className="border-t border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete profile
        </button>
      </div>
    </div>
  );
}

function FormSection({
  title,
  icon,
  children,
  className = '',
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
        {icon ? <span className="text-[var(--text-muted)]">{icon}</span> : null}
        <span>{title}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
      <div className="pt-1.5 text-[12px] font-medium text-[var(--text-secondary)]">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function AvatarPicker({
  profile,
  onChange,
}: {
  profile: AgentProfile;
  onChange: (key: AgentAvatarAssetKey) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {AGENT_AVATAR_OPTIONS.map((option) => {
        const active = profile.avatar.key === option.key;
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => onChange(option.key)}
            className={`rounded-lg p-1 transition-colors ${
              active
                ? 'bg-[var(--sidebar-item-active)] ring-1 ring-[var(--accent)]/35'
                : 'hover:bg-[var(--bg-secondary)]'
            }`}
            aria-label={`Use ${option.label} avatar`}
            aria-pressed={active}
            title={option.label}
          >
            <AgentAvatar
              avatarKey={option.key}
              label={option.label}
              size="lg"
            />
          </button>
        );
      })}
    </div>
  );
}
