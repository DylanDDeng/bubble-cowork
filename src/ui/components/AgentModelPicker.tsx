import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronLeft } from 'lucide-react';
import type { AgentProvider, ClaudeCompatibleProviderId, ClaudeModelConfig } from '../types';
import { PROVIDERS } from '../utils/provider';
import { buildClaudeModelOptions, formatClaudeModelLabel, supportsClaude1mContext } from '../utils/claude-model';
import { buildCodexModelOptions, formatCodexModelLabel } from '../utils/codex-model';
import claudeLogo from '../assets/claude-color.svg';
import minimaxLogo from '../assets/minimax-color.svg';
import moonshotLogo from '../assets/moonshot.svg';
import openaiLogo from '../assets/openai.svg';
import zhipuLogo from '../assets/zhipu-color.svg';

type PickerMode = 'provider' | 'model';

interface AgentModelPickerProps {
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  disabled?: boolean;
  claudeModel?: {
    value: string | null;
    config: ClaudeModelConfig;
    runtimeModel?: string | null;
    context1m?: boolean;
    compatibleOptions?: Array<{
      id: ClaudeCompatibleProviderId;
      label: string;
      model: string;
    }>;
    onToggleContext1m?: (enabled: boolean) => void;
    onChange: (model: string) => void;
  };
  codexModel?: {
    value: string | null;
    options: string[];
    runtimeModel?: string | null;
    onChange: (model: string) => void;
  };
}

function ProviderIcon({ provider }: { provider: AgentProvider }) {
  if (provider === 'claude') {
    return <img src={claudeLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  if (provider === 'codex') {
    return <img src={openaiLogo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
  }

  return null;
}

function CompatibleProviderIcon({ providerId }: { providerId: ClaudeCompatibleProviderId }) {
  const logo =
    providerId === 'minimax'
      ? minimaxLogo
      : providerId === 'zhipu'
        ? zhipuLogo
        : moonshotLogo;
  return <img src={logo} alt="" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
}

export function AgentModelPicker({
  provider,
  onProviderChange,
  disabled,
  claudeModel,
  codexModel,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PickerMode>('provider');
  const currentProvider = PROVIDERS.find((item) => item.id === provider) || PROVIDERS[0];

  const claudeOptions = useMemo(
    () =>
      claudeModel
        ? buildClaudeModelOptions(claudeModel.config, [claudeModel.value, claudeModel.runtimeModel])
        : [],
    [claudeModel]
  );
  const compatibleOptions = claudeModel?.compatibleOptions || [];
  const claudePrimaryOptions = useMemo(
    () =>
      compatibleOptions.length > 0
        ? claudeOptions.filter(
            (model) => !compatibleOptions.some((compatible) => compatible.model === model)
          )
        : claudeOptions,
    [claudeOptions, compatibleOptions]
  );

  const codexOptions = useMemo(() => codexModel?.options || [], [codexModel]);

  const hasModelOptions =
    (provider === 'claude' && claudeOptions.length > 0) ||
    (provider === 'codex' && codexOptions.length > 0);

  const openMode = mode === 'model' && hasModelOptions ? 'model' : 'provider';
  const currentCompatibleOption = useMemo(() => {
    if (provider !== 'claude' || !claudeModel) {
      return null;
    }

    const resolvedValue =
      claudeModel.value || claudeModel.config.defaultModel || claudeOptions[0] || '';
    return compatibleOptions.find((option) => option.model === resolvedValue) || null;
  }, [provider, claudeModel, claudeOptions, compatibleOptions]);

  const currentModelLabel = useMemo(() => {
    if (provider === 'claude' && claudeModel) {
      const resolvedValue =
        claudeModel.value || claudeModel.config.defaultModel || claudeOptions[0] || '';
      if (currentCompatibleOption) {
        return currentCompatibleOption.model;
      }
      return resolvedValue
        ? formatClaudeModelLabel(resolvedValue, claudeModel.context1m)
        : currentProvider.label;
    }

    if (provider === 'codex' && codexModel) {
      const resolvedValue = codexModel.value || codexOptions[0] || '';
      return resolvedValue ? formatCodexModelLabel(resolvedValue) : currentProvider.label;
    }

    return currentProvider.label;
  }, [provider, claudeModel, claudeOptions, currentCompatibleOption, codexModel, codexOptions, currentProvider.label]);

  const handleTriggerClick = () => {
    if (disabled) return;
    setMode(hasModelOptions ? 'model' : 'provider');
    setOpen((current) => !current);
  };

  const handleProviderSelect = (nextProvider: AgentProvider) => {
    onProviderChange(nextProvider);
    setOpen(false);
    setMode('model');
  };

  const renderModelItems = () => {
    if (provider === 'claude' && claudeModel) {
      const resolvedValue =
        claudeModel.value || claudeModel.config.defaultModel || claudeOptions[0] || '';

      return (
        <>
          <div className="px-2 py-1 text-[11px] font-medium text-[var(--text-muted)]">
            Claude Code
          </div>
          {claudePrimaryOptions.map((model) => (
            <button
              key={model}
              onClick={() => {
                claudeModel.onChange(model);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[#F3F3F3]"
              title={model}
            >
              <div className="min-w-0 truncate">{formatClaudeModelLabel(model)}</div>
              {resolvedValue === model && (
                <Check className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
              )}
            </button>
          ))}
          {compatibleOptions.map((option) => (
            <div key={option.id} className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="px-2 py-1 text-[11px] font-medium text-[var(--text-muted)]">
                {option.label}
              </div>
              <button
                onClick={() => {
                  claudeModel.onChange(option.model);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[#F3F3F3]"
                title={option.model}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <CompatibleProviderIcon providerId={option.id} />
                  <div className="min-w-0 truncate">{option.model}</div>
                </div>
                {resolvedValue === option.model && (
                  <Check className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
                )}
              </button>
            </div>
          ))}
        </>
      );
    }

    if (provider === 'codex' && codexModel) {
      const resolvedValue = codexModel.value || codexOptions[0] || '';

      return codexOptions.map((model) => (
        <button
          key={model}
          onClick={() => {
            codexModel.onChange(model);
            setOpen(false);
          }}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[#F3F3F3]"
          title={model}
        >
          <div className="min-w-0 truncate">{formatCodexModelLabel(model)}</div>
          {resolvedValue === model && (
            <Check className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" />
          )}
        </button>
      ));
    }

    return null;
  };

  return (
    <div className="relative no-drag">
      <button
        onClick={handleTriggerClick}
        disabled={disabled}
        className="flex items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-3 py-1.5 text-sm transition-colors hover:bg-[#EEEEEE] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {currentCompatibleOption ? (
          <CompatibleProviderIcon providerId={currentCompatibleOption.id} />
        ) : (
          <ProviderIcon provider={currentProvider.id} />
        )}
        <span className="max-w-[140px] truncate text-[var(--text-secondary)]">
          {hasModelOptions ? currentModelLabel : currentProvider.label}
        </span>
        <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
      </button>

      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[220px] rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-1 shadow-lg">
            {openMode === 'provider' ? (
              <>
                {PROVIDERS.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleProviderSelect(item.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      item.id === provider
                        ? 'bg-[var(--accent-light)] text-[var(--accent)]'
                        : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <ProviderIcon provider={item.id} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  onClick={() => setMode('provider')}
                  className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Change Agent</span>
                </button>
                {renderModelItems()}
                {provider === 'claude' &&
                  claudeModel &&
                  supportsClaude1mContext(
                    claudeModel.value || claudeModel.config.defaultModel || claudeOptions[0] || ''
                  ) &&
                  claudeModel.onToggleContext1m && (
                    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/70 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[var(--text-primary)]">
                            1M context
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => claudeModel.onToggleContext1m?.(!claudeModel.context1m)}
                          aria-label="Toggle 1M context"
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                            claudeModel.context1m
                              ? 'border-transparent bg-[var(--accent)]'
                              : 'border-[var(--border)] bg-[var(--bg-secondary)]'
                          }`}
                        >
                          <span
                            className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                              claudeModel.context1m ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                  )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
