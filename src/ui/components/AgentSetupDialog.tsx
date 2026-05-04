import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, CircleDashed, Eye, EyeOff, Plus, RefreshCw, Settings, X } from 'lucide-react';
import { toast } from 'sonner';
import claudeLogo from '../assets/claude-color.svg';
import openaiLogo from '../assets/openai.svg';
import { OpenCodeLogo } from './OpenCodeLogo';
import { AgentAvatar, AGENT_AVATAR_OPTIONS } from './AgentAvatar';
import { useAppStore } from '../store/useAppStore';
import type {
  AegisBuiltInAgentConfig,
  AgentPermissionPolicy,
  AgentProfile,
  AgentProfileColor,
  AgentProvider,
  AgentReasoningEffort,
} from '../types';
import { useAgentReadiness, type AgentReadinessEntry, type AgentReadinessState } from '../hooks/useAgentReadiness';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useCompatibleProviderConfig, type CompatibleProviderOption } from '../hooks/useCompatibleProviderConfig';
import {
  buildClaudeModelOptions,
  loadPreferredClaudeCompatibleProviderId,
  loadPreferredClaudeModel,
} from '../utils/claude-model';
import {
  getCodexReasoningOptions,
  getDefaultCodexReasoningEffort,
} from '../utils/codex-reasoning';
import {
  loadPreferredCodexModel,
  resolveCodexModel,
} from '../utils/codex-model';
import { loadPreferredOpencodeModel } from '../utils/opencode-model';
import {
  AEGIS_BUILT_IN_PROVIDERS,
  getAegisBuiltInModel,
  getAegisBuiltInProvider,
  listAegisBuiltInModels,
  resolveAegisBuiltInModel,
} from '../../shared/aegis-built-in-catalog';

const FIELD_CONTROL_CLASS =
  'h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 text-[12.5px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]';

const TEXTAREA_CONTROL_CLASS =
  'min-h-[68px] w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[12.5px] leading-5 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]';

const AGENT_COLORS: Array<{ value: AgentProfileColor; label: string }> = [
  { value: 'amber', label: 'Amber' },
  { value: 'sky', label: 'Sky' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'violet', label: 'Violet' },
  { value: 'rose', label: 'Rose' },
  { value: 'slate', label: 'Slate' },
];

const CLAUDE_REASONING_OPTIONS: Array<{ effort: AgentReasoningEffort; description: string }> = [
  { effort: 'low', description: 'Fastest response' },
  { effort: 'medium', description: 'Balanced default' },
  { effort: 'high', description: 'Deeper reasoning' },
  { effort: 'xhigh', description: 'Extra deep reasoning' },
  { effort: 'max', description: 'Maximum reasoning' },
];

const AEGIS_REASONING_OPTIONS: Array<{ effort: AgentReasoningEffort; description: string }> = [
  { effort: 'high', description: 'DeepSeek thinking default' },
  { effort: 'max', description: 'Maximum DeepSeek reasoning' },
];

function isAegisDeepSeekV4Model(model?: string | null): boolean {
  const selection = resolveAegisBuiltInModel(model);
  return (
    selection.providerId === 'deepseek' &&
    (selection.modelId === 'deepseek-v4-flash' || selection.modelId === 'deepseek-v4-pro')
  );
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

type AgentSetupDraft = {
  name: string;
  role: string;
  description: string;
  instructions: string;
  avatar: AgentProfile['avatar'];
  provider: AgentProvider;
  model?: string;
  compatibleProviderId?: AgentProfile['compatibleProviderId'];
  reasoningEffort?: AgentReasoningEffort;
  permissionPolicy: AgentPermissionPolicy;
  canDelegate: boolean;
  color: AgentProfileColor;
};

export function AgentSetupDialog() {
  const {
    agentSetupOpen,
    dismissAgentSetup,
    completeAgentSetup,
    createAgentProfile,
    updateAgentProfile,
    setProjectAgentRoster,
    projectAgentRostersByProject,
    projectCwd,
    setShowSettings,
    setActiveSettingsTab,
  } = useAppStore();
  const claudeModelConfig = useClaudeModelConfig();
  const { compatibleOptions } = useCompatibleProviderConfig();
  const codexModelConfig = useCodexModelConfig();
  const opencodeModelConfig = useOpencodeModelConfig();
  const claudeModelOptions = useMemo(
    () =>
      buildClaudeModelOptions(
        claudeModelConfig,
        compatibleOptions.map((option) => option.model)
      ),
    [claudeModelConfig, compatibleOptions]
  );
  const preferredClaudeModel = loadPreferredClaudeModel();
  const selectedClaudeModel =
    preferredClaudeModel || claudeModelConfig.defaultModel || claudeModelOptions[0] || null;
  const selectedClaudeCompatibleProviderId = useMemo(() => {
    const preferredProviderId = loadPreferredClaudeCompatibleProviderId();
    if (!preferredProviderId || !selectedClaudeModel) {
      return null;
    }

    return compatibleOptions.some(
      (option) => option.id === preferredProviderId && option.model === selectedClaudeModel
    )
      ? preferredProviderId
      : null;
  }, [compatibleOptions, selectedClaudeModel]);
  const readiness = useAgentReadiness(selectedClaudeModel, agentSetupOpen);
  const readyEntries = readiness.entries.filter((entry) => entry.state === 'ready');
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [profileDraft, setProfileDraft] = useState<AgentSetupDraft | null>(null);
  const [profileFormCollapsed, setProfileFormCollapsed] = useState(false);
  const currentProjectCwd = projectCwd?.trim() || null;
  const selectedCodexModel = resolveCodexModel(loadPreferredCodexModel(), codexModelConfig);
  const selectedCodexReasoningEffort = getDefaultCodexReasoningEffort(
    codexModelConfig,
    selectedCodexModel
  );
  const selectedOpencodeModel =
    loadPreferredOpencodeModel() ||
    opencodeModelConfig.defaultModel ||
    opencodeModelConfig.options[0] ||
    null;

  useEffect(() => {
    if (!agentSetupOpen) return;

    setSelectedProvider((current) => {
      const currentEntry = readiness.entries.find((entry) => entry.provider === current);
      if (currentEntry && (currentEntry.state === 'ready' || readyEntries.length === 0)) {
        return current;
      }
      return readyEntries[0]?.provider || currentEntry?.provider || readiness.entries[0]?.provider || null;
    });
  }, [agentSetupOpen, readiness.entries, readyEntries]);

  const selectedEntry =
    readiness.entries.find((entry) => entry.provider === selectedProvider) || readiness.entries[0] || null;
  const selectedReady = selectedEntry?.state === 'ready';
  const profileNameReady = Boolean(profileDraft?.name.trim());
  const selectedModelOptions = useMemo(
    () =>
      profileDraft
        ? getModelOptionsForProvider(profileDraft.provider, profileDraft.model, {
            aegis: [],
            claude: claudeModelOptions,
            codex: codexModelConfig.options,
            opencode: opencodeModelConfig.options,
          })
        : [],
    [
      claudeModelOptions,
      codexModelConfig.options,
      opencodeModelConfig.options,
      profileDraft?.model,
      profileDraft?.provider,
    ]
  );
  const selectedReasoningOptions = useMemo(() => {
    if (!profileDraft) return [];
    if (profileDraft.provider === 'claude') return CLAUDE_REASONING_OPTIONS;
    if (profileDraft.provider === 'codex') {
      return getCodexReasoningOptions(codexModelConfig, profileDraft.model || null).map((option) => ({
        effort: option.effort,
        description: option.description,
      }));
    }
    return [];
  }, [codexModelConfig, profileDraft?.model, profileDraft?.provider]);

  useEffect(() => {
    if (!agentSetupOpen) {
      setProfileDraft(null);
      setProfileFormCollapsed(false);
      return;
    }
    if (!selectedEntry) {
      return;
    }

    setProfileDraft((current) => {
      if (current?.provider === selectedEntry.provider) {
        return current;
      }

      return buildDefaultAgentDraft({
        provider: selectedEntry.provider,
        claudeModel: selectedClaudeModel,
        claudeCompatibleProviderId: selectedClaudeCompatibleProviderId,
        codexModel: selectedCodexModel,
        codexReasoningEffort: selectedCodexReasoningEffort,
        opencodeModel: selectedOpencodeModel,
      });
    });
  }, [
    agentSetupOpen,
    selectedEntry?.provider,
    selectedClaudeCompatibleProviderId,
    selectedClaudeModel,
    selectedCodexModel,
    selectedCodexReasoningEffort,
    selectedOpencodeModel,
  ]);

  useEffect(() => {
    if (agentSetupOpen) {
      setProfileFormCollapsed(false);
    }
  }, [agentSetupOpen, selectedEntry?.provider]);

  const handleOpenSettings = () => {
    setActiveSettingsTab('providers');
    setShowSettings(true);
    dismissAgentSetup();
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success('Command copied.');
    } catch {
      toast.error('Failed to copy command.');
    }
  };

  const handleCreateAgent = (addToProject: boolean) => {
    if (!selectedEntry || selectedEntry.state !== 'ready' || !profileDraft?.name.trim()) {
      return;
    }

    const profileId = createAgentProfile();
    updateAgentProfile(profileId, buildAgentProfilePatch(profileDraft));

    if (addToProject && currentProjectCwd) {
      const currentRoster = projectAgentRostersByProject[currentProjectCwd] || [];
      setProjectAgentRoster(
        currentProjectCwd,
        currentRoster.includes(profileId) ? currentRoster : [...currentRoster, profileId]
      );
    }

    toast.success(addToProject && currentProjectCwd ? 'Agent created and added to project.' : 'Agent created.');
    completeAgentSetup();
  };

  return (
    <Dialog.Root open={agentSetupOpen} onOpenChange={(open) => {
      if (!open) {
        dismissAgentSetup();
      }
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[85] bg-[rgba(15,23,42,0.28)] backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[90] flex max-h-[min(760px,calc(100vh-48px))] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-2xl outline-none">
          <div className="flex items-start justify-between gap-5 border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[18px] font-semibold text-[var(--text-primary)]">
                Set up local agents
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--text-muted)]">
                {readiness.loading
                  ? 'Checking local runtimes.'
                  : `${readiness.readyCount} ready · ${readiness.setupCount} need setup`}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={readiness.refresh}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className={`h-4 w-4 ${readiness.loading ? 'animate-spin' : ''}`} />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  title="Close"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-2">
              {readiness.entries.map((entry) => (
                <RuntimeSetupRow
                  key={entry.provider}
                  entry={entry}
                  selected={selectedProvider === entry.provider}
                  onSelect={() => setSelectedProvider(entry.provider)}
                  onCopyCommand={entry.command ? () => void handleCopyCommand(entry.command || '') : undefined}
                  onOpenSettings={handleOpenSettings}
                />
              ))}
            </div>

            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
              {selectedEntry && profileDraft ? (
                <AgentProfileSetupForm
                  draft={profileDraft}
                  runtimeReady={selectedReady}
                  selectedEntry={selectedEntry}
                  modelOptions={selectedModelOptions}
                  compatibleOptions={compatibleOptions}
                  reasoningOptions={selectedReasoningOptions}
                  collapsed={profileFormCollapsed}
                  onToggleCollapsed={() => setProfileFormCollapsed((collapsed) => !collapsed)}
                  onChange={(patch) => {
                    setProfileDraft((current) =>
                      current ? normalizeDraftPatch(current, patch, compatibleOptions) : current
                    );
                  }}
                />
              ) : (
                <div className="text-[13px] text-[var(--text-muted)]">No runtime selected.</div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4">
            <button
              type="button"
              onClick={dismissAgentSetup}
              className="inline-flex h-8 items-center justify-center rounded-md px-3 text-[12.5px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              Skip for now
            </button>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => handleCreateAgent(false)}
                disabled={!selectedReady || !profileNameReady}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12.5px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus className="h-3.5 w-3.5" />
                Create agent
              </button>
              {currentProjectCwd ? (
                <button
                  type="button"
                  onClick={() => handleCreateAgent(true)}
                  disabled={!selectedReady || !profileNameReady}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--text-primary)] px-3 text-[12.5px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create and add to project
                </button>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RuntimeSetupRow({
  entry,
  selected,
  onSelect,
  onCopyCommand,
  onOpenSettings,
}: {
  entry: AgentReadinessEntry;
  selected: boolean;
  onSelect: () => void;
  onCopyCommand?: () => void;
  onOpenSettings: () => void;
}) {
  const tone = getStateTone(entry.state);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-[var(--text-muted)] bg-[var(--bg-primary)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]'
      }`}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--bg-secondary)]">
        {getProviderIcon(entry.provider)}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--text-primary)]">{entry.label}</span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone.badge}`}>
            {tone.icon}
            {entry.summary}
          </span>
        </div>
        <div className="mt-1 truncate text-[12px] text-[var(--text-muted)]">{entry.detail}</div>
      </div>
      {entry.state === 'ready' || entry.state === 'checking' ? (
        <span className="h-2 w-2 rounded-full bg-current text-[var(--text-muted)]" aria-hidden="true" />
      ) : entry.command && onCopyCommand ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onCopyCommand();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onCopyCommand();
            }
          }}
          className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          Copy command
        </span>
      ) : (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onOpenSettings();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onOpenSettings();
            }
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <Settings className="h-3.5 w-3.5" />
          Providers
        </span>
      )}
    </div>
  );
}

function AgentProfileSetupForm({
  draft,
  runtimeReady,
  selectedEntry,
  modelOptions,
  compatibleOptions,
  reasoningOptions,
  collapsed,
  onToggleCollapsed,
  onChange,
}: {
  draft: AgentSetupDraft;
  runtimeReady: boolean;
  selectedEntry: AgentReadinessEntry;
  modelOptions: string[];
  compatibleOptions: CompatibleProviderOption[];
  reasoningOptions: Array<{ effort: AgentReasoningEffort; description: string }>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (patch: Partial<AgentSetupDraft>) => void;
}) {
  const [aegisConfig, setAegisConfig] = useState<AegisBuiltInAgentConfig | null>(null);
  const [aegisApiKeyDrafts, setAegisApiKeyDrafts] = useState<Record<string, string>>({});
  const [showAegisApiKey, setShowAegisApiKey] = useState(false);
  const [savingAegisApiKey, setSavingAegisApiKey] = useState(false);

  useEffect(() => {
    if (draft.provider !== 'aegis') {
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
  }, [draft.provider]);

  const handleModelChange = (model: string) => {
    const nextModel =
      draft.provider === 'aegis'
        ? resolveAegisBuiltInModel(model).encoded
        : model.trim() || undefined;
    const compatibleProviderId =
      draft.provider === 'claude'
        ? findCompatibleProviderIdForModel(nextModel, compatibleOptions)
        : undefined;
    onChange({
      model: nextModel,
      compatibleProviderId,
    });
  };

  const selectedAegisProviderId = draft.provider === 'aegis'
    ? resolveAegisBuiltInModel(draft.model || aegisConfig?.model, aegisConfig?.providerId).providerId
    : null;
  const aegisApiKeyDraft = readAegisApiKeyDraft(aegisApiKeyDrafts, aegisConfig, selectedAegisProviderId);

  const handleSaveAegisApiKey = async () => {
    if (draft.provider !== 'aegis') {
      return;
    }
    setSavingAegisApiKey(true);
    try {
      const currentConfig = aegisConfig || (await window.electron.getAegisBuiltInAgentConfig());
      const selection = resolveAegisBuiltInModel(draft.model || currentConfig.model, currentConfig.providerId);
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

  const aegisApiKeyDirty = draft.provider === 'aegis' && aegisApiKeyDraft !== (
    selectedAegisProviderId && aegisConfig
      ? getAegisProviderApiKey(aegisConfig, selectedAegisProviderId)
      : ''
  );
  const visibleReasoningOptions =
    draft.provider === 'aegis' && isAegisDeepSeekV4Model(draft.model)
      ? AEGIS_REASONING_OPTIONS
      : draft.provider === 'claude' || draft.provider === 'codex'
        ? reasoningOptions
        : [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentAvatar avatar={draft.avatar} label={draft.name || 'Agent'} size="lg" decorative />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[14px] font-medium text-[var(--text-primary)]">Agent profile</div>
              <div className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                {selectedEntry.label}
              </div>
            </div>
            <div className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">
              Configure the profile before creating it.
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {!runtimeReady ? (
            <div className="rounded-md bg-amber-500/10 px-2 py-1 text-[11.5px] font-medium text-amber-700">
              Resolve runtime first
            </div>
          ) : null}
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            title={collapsed ? 'Expand profile settings' : 'Collapse profile settings'}
            aria-label={collapsed ? 'Expand profile settings' : 'Collapse profile settings'}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {collapsed ? (
        <CollapsedAgentProfileSummary draft={draft} />
      ) : (
        <>
      <FormField label="Avatar">
        <div className="flex flex-wrap gap-2">
          {AGENT_AVATAR_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange({ avatar: { type: 'asset', key: option.key } })}
              className={`rounded-md border p-1 transition-colors ${
                draft.avatar.key === option.key
                  ? 'border-[var(--text-muted)] bg-[var(--bg-secondary)]'
                  : 'border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title={option.label}
              aria-label={option.label}
            >
              <AgentAvatar avatarKey={option.key} size="md" decorative />
            </button>
          ))}
        </div>
      </FormField>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FormField label="Name">
          <input
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
            className={FIELD_CONTROL_CLASS}
            placeholder="Agent name"
          />
        </FormField>
        <FormField label="Role">
          <input
            value={draft.role}
            onChange={(event) => onChange({ role: event.target.value })}
            className={FIELD_CONTROL_CLASS}
            placeholder="Coding Agent"
          />
        </FormField>
      </div>

      <FormField label="Description">
        <textarea
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={2}
          className={TEXTAREA_CONTROL_CLASS}
          placeholder="What this agent is good at."
        />
      </FormField>

      <FormField label="Instructions">
        <textarea
          value={draft.instructions}
          onChange={(event) => onChange({ instructions: event.target.value })}
          rows={4}
          className={TEXTAREA_CONTROL_CLASS}
          placeholder="Behavior, constraints, and working style for this agent."
        />
      </FormField>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FormField label="Model">
          {draft.provider === 'aegis' ? (
            <select
              value={resolveAegisBuiltInModel(draft.model).encoded}
              onChange={(event) => handleModelChange(event.target.value)}
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
          ) : modelOptions.length > 0 ? (
            <select
              value={draft.model || ''}
              onChange={(event) => handleModelChange(event.target.value)}
              className={FIELD_CONTROL_CLASS}
            >
              <option value="">Runtime default</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={draft.model || ''}
              onChange={(event) => handleModelChange(event.target.value)}
              className={FIELD_CONTROL_CLASS}
              placeholder="Runtime default"
            />
          )}
        </FormField>

        {draft.provider === 'aegis' ? (
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
                  className={`${FIELD_CONTROL_CLASS} pr-8`}
                  placeholder="Provider API key"
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
        ) : (
        <FormField label="Permission policy">
          <select
            value={draft.permissionPolicy}
            onChange={(event) => onChange({ permissionPolicy: event.target.value as AgentPermissionPolicy })}
            className={FIELD_CONTROL_CLASS}
          >
            <option value="ask">Ask</option>
            <option value="readOnly">Read only</option>
            <option value="fullAccess">Full access</option>
          </select>
        </FormField>
        )}
      </div>

      {draft.provider === 'aegis' ? (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FormField label="Permission policy">
            <select
              value={draft.permissionPolicy}
              onChange={(event) => onChange({ permissionPolicy: event.target.value as AgentPermissionPolicy })}
              className={FIELD_CONTROL_CLASS}
            >
              <option value="ask">Ask</option>
              <option value="readOnly">Read only</option>
              <option value="fullAccess">Full access</option>
            </select>
          </FormField>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {visibleReasoningOptions.length > 0 ? (
          <FormField label="Reasoning">
            <select
              value={draft.provider === 'aegis' ? draft.reasoningEffort || 'high' : draft.reasoningEffort || ''}
              onChange={(event) =>
                onChange({
                  reasoningEffort: event.target.value
                    ? event.target.value as AgentReasoningEffort
                    : undefined,
                })
              }
              className={FIELD_CONTROL_CLASS}
            >
              {draft.provider === 'aegis' ? null : <option value="">Default</option>}
              {visibleReasoningOptions.map((option) => (
                <option key={option.effort} value={option.effort}>
                  {option.effort} · {option.description}
                </option>
              ))}
            </select>
          </FormField>
        ) : (
          <div />
        )}

        <FormField label="Color">
          <select
            value={draft.color}
            onChange={(event) => onChange({ color: event.target.value as AgentProfileColor })}
            className={FIELD_CONTROL_CLASS}
          >
            {AGENT_COLORS.map((color) => (
              <option key={color.value} value={color.value}>
                {color.label}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <label className="flex items-start justify-between gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">Can delegate</span>
          <span className="mt-0.5 block text-[11.5px] leading-4 text-[var(--text-muted)]">
            Allow this agent to assign one visible round of work to other project agents.
          </span>
        </span>
        <input
          type="checkbox"
          checked={draft.canDelegate}
          onChange={(event) => onChange({ canDelegate: event.target.checked })}
          className="mt-0.5 h-4 w-4"
        />
      </label>
        </>
      )}
    </div>
  );
}

function CollapsedAgentProfileSummary({ draft }: { draft: AgentSetupDraft }) {
  const modelLabel = draft.provider === 'aegis'
    ? formatAegisBuiltInModel(draft.model)
    : draft.model || 'Runtime default';

  return (
    <div className="grid gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[12.5px] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-[var(--text-muted)]">Name</div>
        <div className="truncate text-[var(--text-primary)]">{draft.name.trim() || 'Untitled agent'}</div>
      </div>
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-[var(--text-muted)]">Model</div>
        <div className="truncate text-[var(--text-primary)]">{modelLabel}</div>
      </div>
      <div className="flex flex-wrap items-end gap-1.5">
        <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
          {draft.permissionPolicy}
        </span>
        {draft.reasoningEffort ? (
          <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
            {draft.reasoningEffort}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function formatAegisBuiltInModel(value?: string | null): string {
  const selection = resolveAegisBuiltInModel(value);
  const provider = getAegisBuiltInProvider(selection.providerId);
  const model = getAegisBuiltInModel(selection.providerId, selection.modelId);
  return `${provider?.name || selection.providerId} · ${model?.name || selection.modelId}`;
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-[var(--text-muted)]">{label}</div>
      {children}
    </div>
  );
}

function buildDefaultAgentDraft({
  provider,
  claudeModel,
  claudeCompatibleProviderId,
  codexModel,
  codexReasoningEffort,
  opencodeModel,
}: {
  provider: AgentProvider;
  claudeModel: string | null;
  claudeCompatibleProviderId: AgentProfile['compatibleProviderId'] | null;
  codexModel: string | null;
  codexReasoningEffort: AgentReasoningEffort | null;
  opencodeModel: string | null;
}): AgentSetupDraft {
  const preview = buildPreviewProfile(provider);
  const model =
    provider === 'claude'
      ? claudeModel
      : provider === 'codex'
        ? codexModel
        : provider === 'opencode'
          ? opencodeModel
          : resolveAegisBuiltInModel(null).encoded;

  return {
    name: preview.name,
    role: preview.role,
    description: preview.description,
    instructions: preview.instructions,
    avatar: preview.avatar,
    provider,
    model: model || undefined,
    compatibleProviderId: provider === 'claude' ? claudeCompatibleProviderId || undefined : undefined,
    reasoningEffort:
      provider === 'claude'
        ? 'medium'
        : provider === 'codex'
          ? codexReasoningEffort || 'medium'
          : provider === 'aegis'
            ? isAegisDeepSeekV4Model(model) ? 'high' : undefined
          : undefined,
    permissionPolicy: 'ask',
    canDelegate: false,
    color: preview.color,
  };
}

function buildAgentProfilePatch(
  draft: AgentSetupDraft
): Partial<Omit<AgentProfile, 'id' | 'createdAt'>> {
  return {
    name: draft.name.trim() || 'New Agent',
    role: draft.role.trim() || 'Agent',
    description: draft.description,
    instructions: draft.instructions,
    avatar: draft.avatar,
    provider: draft.provider,
    model: draft.model?.trim() || undefined,
    compatibleProviderId:
      draft.provider === 'claude' ? draft.compatibleProviderId || undefined : undefined,
    reasoningEffort:
      draft.provider === 'aegis'
        ? isAegisDeepSeekV4Model(draft.model) ? draft.reasoningEffort || 'high' : undefined
        : draft.provider === 'claude' || draft.provider === 'codex'
        ? draft.reasoningEffort
        : undefined,
    permissionPolicy: draft.permissionPolicy,
    canDelegate: draft.canDelegate,
    color: draft.color,
    enabled: true,
    updatedAt: Date.now(),
  };
}

function normalizeDraftPatch(
  current: AgentSetupDraft,
  patch: Partial<AgentSetupDraft>,
  compatibleOptions: CompatibleProviderOption[]
): AgentSetupDraft {
  const nextProvider = patch.provider || current.provider;
  const rawModel =
    Object.prototype.hasOwnProperty.call(patch, 'model')
      ? patch.model?.trim() || undefined
      : current.model;
  const model =
    nextProvider === 'aegis'
      ? resolveAegisBuiltInModel(rawModel).encoded
      : rawModel;
  const compatibleProviderId =
    nextProvider === 'claude'
      ? Object.prototype.hasOwnProperty.call(patch, 'compatibleProviderId')
        ? patch.compatibleProviderId
        : findCompatibleProviderIdForModel(model, compatibleOptions) || current.compatibleProviderId
      : undefined;

  return {
    ...current,
    ...patch,
    provider: nextProvider,
    model,
    compatibleProviderId,
    reasoningEffort:
      nextProvider === 'opencode'
        ? undefined
        : nextProvider === 'aegis'
          ? isAegisDeepSeekV4Model(model)
            ? patch.reasoningEffort === 'max' || current.reasoningEffort === 'max' ? 'max' : 'high'
            : undefined
        : patch.reasoningEffort !== undefined
          ? patch.reasoningEffort
          : current.reasoningEffort,
    canDelegate:
      patch.canDelegate !== undefined ? patch.canDelegate === true : current.canDelegate,
  };
}

function getModelOptionsForProvider(
  provider: AgentProvider,
  currentModel: string | undefined,
  options: Record<AgentProvider, string[]>
): string[] {
  return Array.from(
    new Set([currentModel, ...options[provider]].filter((value): value is string => Boolean(value?.trim())))
  );
}

function findCompatibleProviderIdForModel(
  model: string | null | undefined,
  compatibleOptions: CompatibleProviderOption[]
): AgentProfile['compatibleProviderId'] | undefined {
  const normalized = model?.trim();
  if (!normalized) {
    return undefined;
  }
  return compatibleOptions.find((option) => option.model === normalized)?.id;
}

function buildPreviewProfile(provider: AgentProvider): AgentProfile {
  const now = Date.now();
  const profileByProvider: Record<AgentProvider, Pick<
    AgentProfile,
    'name' | 'role' | 'description' | 'instructions' | 'avatar' | 'provider' | 'color'
  >> = {
    claude: {
      name: 'Claude Agent',
      role: 'Coding Agent',
      description: 'Uses Claude Code for implementation, review, and project work.',
      instructions: 'Use the project context, explain important tradeoffs, and ask before risky changes.',
      avatar: { type: 'asset', key: 'notion-avatar-01' },
      provider: 'claude',
      color: 'sky',
    },
    aegis: {
      name: 'Aegis Agent',
      role: 'Built-in Coding Agent',
      description: 'Uses the built-in Aegis runtime for customizable project work.',
      instructions: 'Inspect the project first, keep changes focused, and ask before risky edits.',
      avatar: { type: 'asset', key: 'notion-avatar-02' },
      provider: 'aegis',
      color: 'amber',
    },
    codex: {
      name: 'Codex Agent',
      role: 'Coding Agent',
      description: 'Uses Codex for coding tasks with local project context.',
      instructions: 'Keep edits scoped, verify changes, and report blockers with concrete file paths.',
      avatar: { type: 'asset', key: 'notion-avatar-04' },
      provider: 'codex',
      color: 'violet',
    },
    opencode: {
      name: 'OpenCode Agent',
      role: 'Coding Agent',
      description: 'Uses OpenCode for coding tasks through the local OpenCode runtime.',
      instructions: 'Use the available project context and keep file changes focused on the task.',
      avatar: { type: 'asset', key: 'notion-avatar-03' },
      provider: 'opencode',
      color: 'emerald',
    },
  };

  return {
    id: `preview-${provider}`,
    ...profileByProvider[provider],
    permissionPolicy: 'ask',
    canDelegate: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function getProviderIcon(provider: AgentProvider): ReactNode {
  if (provider === 'aegis') {
    return <Bot className="h-5 w-5 text-[var(--text-secondary)]" aria-hidden="true" />;
  }

  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-5 w-5" aria-hidden="true" />;
  }

  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-5 w-5" aria-hidden="true" />;
  }

  return <OpenCodeLogo className="h-5 w-5" />;
}

function getStateTone(state: AgentReadinessState): {
  badge: string;
  icon: ReactNode;
} {
  switch (state) {
    case 'ready':
      return {
        badge: 'bg-emerald-500/10 text-emerald-700',
        icon: <CheckCircle2 className="h-3 w-3" />,
      };
    case 'checking':
      return {
        badge: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
        icon: <RefreshCw className="h-3 w-3 animate-spin" />,
      };
    case 'needs_login':
    case 'needs_config':
      return {
        badge: 'bg-amber-500/12 text-amber-700',
        icon: <AlertTriangle className="h-3 w-3" />,
      };
    case 'missing':
    case 'error':
    default:
      return {
        badge: 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
        icon: <CircleDashed className="h-3 w-3" />,
      };
  }
}
