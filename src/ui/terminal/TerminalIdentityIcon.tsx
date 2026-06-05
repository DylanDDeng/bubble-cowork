import type { TerminalAgentKind } from '../../shared/terminal';
import { Bot, Code2, SquareTerminal, Terminal } from '../components/icons';

export function TerminalIdentityIcon({ agentKind }: { agentKind: TerminalAgentKind }) {
  const Icon =
    agentKind === 'claude' ? Bot : agentKind === 'codex' ? Code2 : agentKind === 'opencode' ? SquareTerminal : Terminal;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />;
}
