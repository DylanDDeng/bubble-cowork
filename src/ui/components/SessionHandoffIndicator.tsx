import type { AgentProvider } from '../types';
import { PROVIDERS } from '../utils/provider';
import { AgentIcon } from './ComposerAgentControls';
import { ArrowRight } from './icons';

function providerLabel(provider: AgentProvider): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label || provider;
}

export function SessionHandoffProviderRoute({
  sourceProvider,
  targetProvider,
}: {
  sourceProvider: AgentProvider;
  targetProvider: AgentProvider;
}) {
  const sourceLabel = providerLabel(sourceProvider);
  const targetLabel = providerLabel(targetProvider);
  const label = `Handoff: ${sourceLabel} to ${targetLabel}`;

  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      title={label}
      aria-label={label}
    >
      <AgentIcon provider={sourceProvider} />
      <ArrowRight
        className="h-2.5 w-2.5 shrink-0 text-[var(--text-muted)]"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <AgentIcon provider={targetProvider} />
    </span>
  );
}
