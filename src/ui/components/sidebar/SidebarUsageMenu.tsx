import { useState } from 'react';
import './SidebarUsageMenu.css';
import { usePlanUsage } from '../../hooks/usePlanUsage';
import { useRecentAgentUsage } from '../../hooks/useRecentAgentUsage';
import { prefetchAgentUsageReport, useAgentUsageReport } from '../../hooks/useAgentUsageReport';
import { useAppStore } from '../../store/useAppStore';
import type { AgentProvider } from '../../types';
import type { PlanUsageSnapshot } from '../../utils/plan-usage-cache';
import { PROVIDERS } from '../../utils/provider';
import { claudeUsageSummary, codexUsageSummary, grokUsageSummary, qoderUsageSummary, tokenUsageSummary } from '../../utils/usage-menu-summary';
import { ProviderIcon } from '../AgentModelPicker';
import { AlertTriangle, ChartColumn, ChevronRight, ExternalLink, Loader2 } from '../icons';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../ui/dropdown-menu';

type PlanSummary = PlanUsageSnapshot<{ fetchedAt: number }> & { summary: string | null };

export function SidebarUsageMenu() {
  const [open, setOpen] = useState(false);
  const selectedProvider = useAppStore((state) => state.usageSettingsProvider);
  useAgentUsageReport(selectedProvider, 365, open);
  const claude = usePlanUsage('claude', open);
  const codex = usePlanUsage('codex', open);
  const grok = usePlanUsage('grok', open);
  const qoder = usePlanUsage('qoder', open);
  const plans: Partial<Record<AgentProvider, PlanSummary>> = {
    claude: { ...claude, summary: claudeUsageSummary(claude.report) },
    codex: { ...codex, summary: codexUsageSummary(codex.report) },
    grok: { ...grok, summary: grokUsageSummary(grok.report) },
    qoder: { ...qoder, summary: qoderUsageSummary(qoder.report) },
  };
  const openUsage = (provider?: AgentProvider) => {
    const store = useAppStore.getState();
    if (provider) store.setUsageSettingsProvider(provider);
    store.setActiveSettingsTab('usage');
    store.setShowSettings(true);
  };

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger openOnHover delay={120} closeDelay={200} className="gap-2 px-2 py-2 text-[var(--text-secondary)]">
        <ChartColumn className="h-4 w-4 text-[var(--text-muted)]" />
        <span>Usage</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-[var(--text-muted)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent side="right" align="end" sideOffset={8} className="flex max-h-[min(580px,var(--available-height))] w-[320px] max-w-[calc(100vw-16px)] flex-col">
        <div className="shrink-0 px-2.5 pb-2 pt-1.5 text-[11px] font-medium text-[var(--text-muted)]">Usage by provider</div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {PROVIDERS.map((provider) => (
            <UsageRow key={provider.id} provider={provider.id} label={provider.id === 'codex' ? 'Codex CLI' : provider.label} plan={plans[provider.id]} enabled={open} onSelect={() => openUsage(provider.id)} />
          ))}
        </div>
        <DropdownMenuSeparator className="shrink-0" />
        <DropdownMenuItem onSelect={() => openUsage()} className="shrink-0 gap-2 px-2.5 text-[13px] text-[var(--text-secondary)]">
          View full usage <ExternalLink className="ml-auto h-3.5 w-3.5" />
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function UsageRow({ provider, label, plan, enabled, onSelect }: {
  provider: AgentProvider; label: string; plan?: PlanSummary; enabled: boolean; onSelect: () => void;
}) {
  const recent = useRecentAgentUsage(provider, enabled && !plan?.summary && !plan?.loading);
  const snapshot = plan?.summary ? plan : recent;
  const summary = plan?.summary || (plan?.loading && !plan.report ? 'Loading usage…'
    : recent.report ? tokenUsageSummary(recent.report.usage)
    : recent.loading ? 'Loading usage…' : 'Usage unavailable');
  const error = plan?.summary ? plan.error : plan?.error || recent.error;
  const timestamp = snapshot.report?.fetchedAt;
  const updated = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const status = error ? updated ? `Update failed · Saved ${updated}` : 'Could not update usage'
    : snapshot.loading && snapshot.report ? 'Refreshing…' : null;
  return (
    <DropdownMenuItem onSelect={onSelect} onMouseEnter={() => { void prefetchAgentUsageReport(provider); }} onFocus={() => { void prefetchAgentUsageReport(provider); }} data-usage-provider={provider} className="h-[50px] items-start gap-2.5 px-2.5 py-2" title={[label, summary, status || (updated ? `Updated ${updated}` : null)].filter(Boolean).join('\n')}>
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${['claude', 'codex', 'kimi', 'grok', 'pi', 'bubble'].includes(provider) ? 'sidebar-usage-monochrome' : ''}`}><ProviderIcon provider={provider} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] leading-[18px] text-[var(--text-primary)]">
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {/* Reserve the status slot so refreshes never add a line or resize the menu. */}
          <span className="flex h-3 w-3 shrink-0 items-center justify-center text-[var(--text-muted)]" role="status" title={status || undefined}>
            {status ? <>
              {error ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              <span className="sr-only">{status}</span>
            </> : null}
          </span>
        </span>
        <span className="block truncate text-[11px] leading-4 text-[var(--text-muted)]">{summary}</span>
      </span>
    </DropdownMenuItem>
  );
}
