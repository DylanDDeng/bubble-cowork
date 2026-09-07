import { toast } from 'sonner';
import { ExternalLink, GitPullRequest, MoreHorizontal } from '../icons';
import * as DropdownMenu from '../ui/dropdown-menu';
import type { SessionPullRequestsState } from './useSessionPullRequests';

export function EnvironmentPullRequestsSection({ prs }: { prs: SessionPullRequestsState }) {
  if (!prs.items.length && !prs.error) return null;
  return <section className="environment-summary-section px-1.5">
    <div className="px-2 py-1 text-[12px] font-medium text-[var(--text-secondary)]">Pull requests</div>
    {prs.error ? <button className="environment-summary-row" onClick={() => void prs.refresh()}>{prs.error} Retry</button> : null}
    {prs.items.map(pr => {
      const status = pr.lookupStatus === 'unknown' ? 'Status unavailable' : pr.lookupStatus === 'not_found' ? 'Not found' :
        `${pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : 'Open'}${pr.lookupStatus === 'cached' ? ' · saved' : ''}`;
      return <div key={pr.url} className="flex items-center">
        <button className="environment-summary-row min-w-0 flex-1" title={`${pr.title}\n${pr.url}\n${pr.headBranch}`} onClick={() => {
          void window.electron.openExternalUrl(pr.url).then(result => { if (!result.ok) toast.error(result.message || 'Could not open pull request.'); });
        }}>
          <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">PR #{pr.number}</span>
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{status}</span>
          <ExternalLink className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        </button>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild><button aria-label={`PR #${pr.number} options`} className="inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)]"><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content data-environment-hub-layer align="end" sideOffset={4}>
            <DropdownMenu.Item onSelect={() => void prs.refresh()}>Refresh status</DropdownMenu.Item>
            <DropdownMenu.Item disabled={prs.busy} onSelect={() => void prs.detach(pr)}>Remove from task</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>;
    })}
  </section>;
}
