import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, PlugZap, Plus, Trash2 } from 'lucide-react';
import { AgentModelPicker } from '../AgentModelPicker';
import { AgentAvatar, AGENT_AVATAR_OPTIONS } from '../AgentAvatar';
import { useAppStore } from '../../store/useAppStore';
import type {
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

function displayName(profile: AgentProfile): string {
  return profile.name.trim() || 'Untitled agent';
}

function displayRole(profile: AgentProfile): string {
  return profile.role.trim() || 'Agent';
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
      <SettingsGroup
        title="Agent Profiles"
        description="Reusable agent identities for direct messages and project rosters."
      >
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
            <div className="mt-0.5 text-[12px] leading-5 text-[var(--text-muted)]">
              {profiles.length === 1 ? '1 profile configured.' : `${profiles.length} profiles configured.`}
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
            className="w-full px-4 py-5 text-left text-[13px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          >
            Create an agent profile.
          </button>
        ) : (
          profiles.map((profile) => (
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
          ))
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
        className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--bg-secondary)]/60"
      >
        <AgentAvatar profile={profile} size="md" decorative />
        <div className="min-w-0 flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
            {displayName(profile)}
          </span>
          <span className="truncate text-[11.5px] text-[var(--text-muted)]">
            {displayRole(profile)}
          </span>
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <SettingsToggle
            checked={profile.enabled}
            onChange={(enabled) => onUpdate({ enabled })}
            ariaLabel={profile.enabled ? `Disable ${displayName(profile)}` : `Enable ${displayName(profile)}`}
          />
          <ChevronDown
            className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-4">
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
          : profile.reasoningEffort,
    });
  };

  return (
    <div className="space-y-5">
      <FormSection title="Identity">
        <FormField label="Avatar">
          <AvatarPicker
            profile={profile}
            onChange={(key) => onUpdate({ avatar: { type: 'asset', key } })}
          />
        </FormField>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
        </div>

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

      <FormSection title="Runtime">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FormField label="Provider">
            <select
              value={profile.provider}
              onChange={(event) => handleProviderChange(event.target.value as AgentProfile['provider'])}
              className={FIELD_CONTROL_CLASS}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </FormField>
          <FormField label="Model">
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
          </FormField>
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {profile.provider !== 'opencode' ? (
            <FormField label="Reasoning">
              <select
                value={profile.reasoningEffort || ''}
                onChange={(event) => (
                  onUpdate({ reasoningEffort: event.target.value ? event.target.value as AgentReasoningEffort : undefined })
                )}
                className={FIELD_CONTROL_CLASS}
              >
                <option value="">Default</option>
                {(profile.provider === 'codex' ? CODEX_REASONING_OPTIONS : CLAUDE_REASONING_OPTIONS).map((option) => (
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
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FormField label="Color">
            <select
              value={profile.color}
              onChange={(event) => onUpdate({ color: event.target.value as AgentProfileColor })}
              className={FIELD_CONTROL_CLASS}
            >
              {AGENT_COLORS.map((color) => (
                <option key={color.value} value={color.value}>
                  {color.label}
                </option>
              ))}
            </select>
          </FormField>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[var(--text-primary)]">Can delegate</div>
              <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--text-muted)]">
                Allow one visible round of work to other project agents.
              </div>
            </div>
            <SettingsToggle
              checked={profile.canDelegate === true}
              onChange={(canDelegate) => onUpdate({ canDelegate })}
              ariaLabel="Allow agent delegation"
            />
          </div>
        </div>
      </FormSection>

      <button
        type="button"
        onClick={onDelete}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete profile
      </button>
    </div>
  );
}

function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-[var(--text-muted)]">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
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
    <div>
      <div className="mb-1 text-[12px] font-medium text-[var(--text-muted)]">{label}</div>
      {children}
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
