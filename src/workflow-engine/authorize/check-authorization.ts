// Check commands are started by the app itself, outside every agent's
// permission system, while their argv comes from the Planner. A command may
// therefore only run after it is authorized: automatically when it is a
// recognized project script, the user's own literal command, or one the user
// approved before; otherwise by the user confirming the plan card.

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type CheckAuthorizationContext = {
  /** Scripts declared by the project manifest and the package managers it uses. */
  projectScripts: { packageManagers: PackageManager[]; scripts: string[] } | null;
  /** The user's request text for this run. */
  userText: string;
  /** Commands the user approved earlier for this project. */
  approvedCommands: string[][];
};

export type HighlightReason =
  | 'shell-inline'
  | 'interpreter-inline'
  | 'eval'
  | 'network'
  | 'package-download-exec'
  | 'privilege';

export type CheckAuthorization =
  | { kind: 'auto'; basis: 'project-script' | 'user-literal' | 'previously-approved' }
  | { kind: 'confirm'; highlight: boolean; reasons: HighlightReason[] };

export type UnboundedReason = 'watch-flag' | 'background-operator' | 'detach-wrapper';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const NETWORK_TOOLS = new Set(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'telnet']);
const PRIVILEGE_TOOLS = new Set(['sudo', 'doas', 'su']);
const DETACH_WRAPPERS = new Set(['nohup', 'setsid', 'disown', 'daemonize', 'screen', 'tmux']);
/** Interpreter → flags that take inline code. */
const INLINE_CODE_FLAGS: Record<string, ReadonlySet<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  bun: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python2: new Set(['-c']),
  python3: new Set(['-c']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
  osascript: new Set(['-e']),
  pwsh: new Set(['-c', '-command']),
  powershell: new Set(['-c', '-command']),
};

const basename = (command: string) => command.slice(command.lastIndexOf('/') + 1);

/** Drop wrappers that only adjust how the real command runs (env, time, nice, timeout). */
function unwrap(argv: string[]): string[] {
  let rest = argv;
  for (;;) {
    const head = rest[0] === undefined ? '' : basename(rest[0]);
    if (head === 'env') {
      let i = 1;
      while (i < rest.length) {
        const arg = rest[i];
        if (arg === '-u' || arg === '--unset') i += 2;
        else if (arg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) i += 1;
        else break;
      }
      rest = rest.slice(i);
    } else if (head === 'time' || head === 'nice') {
      let i = 1;
      while (i < rest.length && rest[i].startsWith('-')) i += head === 'nice' && rest[i] === '-n' ? 2 : 1;
      rest = rest.slice(i);
    } else if (head === 'timeout') {
      let i = 1;
      while (i < rest.length && rest[i].startsWith('-')) i += 1;
      rest = rest.slice(i + 1); // skip the duration
    } else {
      return rest;
    }
  }
}

/** Reasons a command must always be confirmed and highlighted on the plan card. */
export function highlightReasons(argv: string[]): HighlightReason[] {
  const reasons = new Set<HighlightReason>();
  const inner = unwrap(argv);
  if (inner.length === 0) return [];
  const head = basename(inner[0]).toLowerCase();
  const args = inner.slice(1);

  if (SHELLS.has(head) && args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) reasons.add('shell-inline');
  const inlineFlags = INLINE_CODE_FLAGS[head];
  if (inlineFlags && args.some((arg) => inlineFlags.has(arg.toLowerCase()) || /^--(eval|print)=/.test(arg))) {
    reasons.add('interpreter-inline');
  }
  if (head === 'deno' && args[0] === 'eval') reasons.add('interpreter-inline');
  if (head === 'eval') reasons.add('eval');
  if (NETWORK_TOOLS.has(head)) reasons.add('network');
  if (PRIVILEGE_TOOLS.has(head)) reasons.add('privilege');
  if (
    head === 'npx' ||
    head === 'pnpx' ||
    head === 'bunx' ||
    head === 'uvx' ||
    (head === 'npm' && args[0] === 'exec') ||
    (head === 'pnpm' && args[0] === 'dlx') ||
    (head === 'yarn' && args[0] === 'dlx') ||
    (head === 'bun' && args[0] === 'x') ||
    (head === 'pipx' && args[0] === 'run')
  ) {
    reasons.add('package-download-exec');
  }
  return [...reasons];
}

/** Script name when argv runs a declared project script through an allowed package manager. */
export function matchProjectScript(
  argv: string[],
  projectScripts: CheckAuthorizationContext['projectScripts'],
): string | null {
  if (!projectScripts) return null;
  const [manager, ...args] = argv;
  if (!(projectScripts.packageManagers as string[]).includes(manager)) return null;
  const has = (name: string | undefined): name is string => !!name && projectScripts.scripts.includes(name);

  let script: string | undefined;
  if (args.length === 2 && (args[0] === 'run' || (manager === 'npm' && args[0] === 'run-script'))) script = args[1];
  else if (args.length === 1 && manager === 'npm' && (args[0] === 'test' || args[0] === 't')) script = 'test';
  else if (args.length === 1 && manager === 'npm' && args[0] === 'start') script = 'start';
  else if (args.length === 1 && (manager === 'pnpm' || manager === 'yarn')) script = args[0];
  return has(script) ? script : null;
}

const normalizeSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

/** True when the user's own text contains exactly this command as a standalone token run. */
export function appearsLiterallyInUserText(argv: string[], userText: string): boolean {
  if (argv.some((arg) => arg === '' || /\s/.test(arg))) return false;
  const command = argv.join(' ');
  const text = normalizeSpace(userText);
  let from = 0;
  for (;;) {
    const at = text.indexOf(command, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + command.length] ?? '';
    const boundary = (ch: string) => ch === '' || !/[A-Za-z0-9_./=-]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = at + 1;
  }
}

export function sameArgv(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

export function authorizeCheckCommand(argv: string[], context: CheckAuthorizationContext): CheckAuthorization {
  const reasons = highlightReasons(argv);
  if (reasons.length > 0) return { kind: 'confirm', highlight: true, reasons };
  if (context.approvedCommands.some((approved) => sameArgv(approved, argv))) {
    return { kind: 'auto', basis: 'previously-approved' };
  }
  if (matchProjectScript(argv, context.projectScripts)) return { kind: 'auto', basis: 'project-script' };
  if (appearsLiterallyInUserText(argv, context.userText)) return { kind: 'auto', basis: 'user-literal' };
  return { kind: 'confirm', highlight: false, reasons: [] };
}

/** Reasons a command cannot serve as an automatic check because it may not terminate on its own. */
export function unboundedReasons(argv: string[]): UnboundedReason[] {
  const reasons = new Set<UnboundedReason>();
  if (argv.some((arg) => arg === '--watch' || arg === '--watchAll' || arg.startsWith('--watch='))) {
    reasons.add('watch-flag');
  }
  if (argv.some((arg) => arg === '&' || arg === '&&' || arg.endsWith(' &'))) reasons.add('background-operator');
  if (DETACH_WRAPPERS.has(basename(argv[0] ?? ''))) reasons.add('detach-wrapper');
  return [...reasons];
}

/**
 * Runtime guard: the argv about to run must equal one the user authorized
 * for this run, byte for byte.
 */
export function isAuthorizedAtRuntime(argv: string[], authorized: string[][]): boolean {
  return authorized.some((approved) => sameArgv(approved, argv));
}
