import type { TerminalActivityState } from '../../shared/terminal';

function activityClass(activity: TerminalActivityState | null): string | null {
  if (activity === 'running') return 'bg-emerald-400';
  if (activity === 'attention') return 'bg-amber-400';
  if (activity === 'review') return 'bg-sky-400';
  return null;
}

export function TerminalActivityIndicator({ activity }: { activity: TerminalActivityState | null }) {
  const className = activityClass(activity);
  if (!className) return null;
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} title={activity} aria-hidden="true" />;
}
