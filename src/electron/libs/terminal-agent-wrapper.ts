import { app } from 'electron';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { delimiter, dirname, join, sep } from 'path';
import { tmpdir } from 'os';
import type { ManagedTerminalAgentKind } from '../../shared/terminal';

const OSC_PREFIX = '633;AEGIS_AGENT_EVENT=';
const WRAPPER_ENV_BYPASS = 'AEGIS_TERMINAL_WRAPPER_BYPASS';

export type ManagedTerminalEnvironment = {
  ok: boolean;
  env: Record<string, string>;
  wrapperBinDir?: string;
  zshDotDir?: string;
  launchCommands: Partial<Record<ManagedTerminalAgentKind, string>>;
  message?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensurePrivateDirectory(dir: string): void {
  if (existsSync(dir)) {
    const stats = lstatSync(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Managed terminal path is not a directory: ${dir}`);
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

function writePrivateFile(filePath: string, content: string, mode: number): void {
  ensurePrivateDirectory(dirname(filePath));
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink: ${filePath}`);
  }

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, { mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, filePath);
  chmodSync(filePath, mode);
}

function writePrivateExecutable(filePath: string, content: string): void {
  writePrivateFile(filePath, content, 0o700);
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(command: string, env: Record<string, string>, excludeDir: string): string | null {
  if (command.includes('/') || (process.platform === 'win32' && /^[a-z]:\\/i.test(command))) {
    return isExecutable(command) ? command : null;
  }

  const pathEnv = env.PATH || process.env.PATH || '';
  const excludeRealDir = existsSync(excludeDir) ? realpathSync(excludeDir) : excludeDir;
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || dir === excludeDir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (!isExecutable(candidate)) continue;
      const realCandidate = realpathSync(candidate);
      if (realCandidate === excludeRealDir || realCandidate.startsWith(`${excludeRealDir}${sep}`)) {
        continue;
      }
      return candidate;
    }
  }

  return null;
}

// Shell function shared by the hook and the wrappers: write one Aegis OSC
// event to the controlling terminal (or stdout when asked, for tests).
const OSC_EMITTER = `aegis_osc() {
  if [ "\${AEGIS_TERMINAL_OSC_STDOUT:-0}" != "1" ] && [ -w /dev/tty ]; then
    printf '\\033]${OSC_PREFIX}%s\\007' "$1" 2>/dev/null > /dev/tty && return 0
  fi
  printf '\\033]${OSC_PREFIX}%s\\007' "$1"
}`;

/**
 * Hook entry point for agent notifications. It only finds the agent and the
 * raw event name in the payload and forwards both; the app classifies event
 * names (see classifyAgentEvent), so new hook names need no shell change.
 */
function buildHookScript(): string {
  return `#!/bin/sh
set -u
payload="\${1:-}"
[ -n "$payload" ] || payload="$(cat 2>/dev/null || true)"

${OSC_EMITTER}

json_field() {
  printf '%s' "$payload" | tr -d '\\n' | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p'
}

agent="$(json_field agent)"
[ -n "$agent" ] || agent="\${AEGIS_TERMINAL_AGENT:-}"
[ "$agent" = claude ] || [ "$agent" = codex ] || exit 0

name=""
for key in hook_event_name event type; do
  [ -n "$name" ] || name="$(json_field "$key")"
done
[ -n "$name" ] && aegis_osc "{\\"agent\\":\\"$agent\\",\\"event\\":\\"$name\\"}"
exit 0
`;
}

const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification'];
const CLAUDE_EVENTS_WITHOUT_MATCHER = new Set(['UserPromptSubmit', 'Stop']);

function buildClaudeSettingsJson(hookPath: string): string {
  const command = `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}`;
  const hooks = Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((event) => [
      event,
      [{ ...(CLAUDE_EVENTS_WITHOUT_MATCHER.has(event) ? {} : { matcher: '*' }), hooks: [{ type: 'command', command }] }],
    ])
  );
  return JSON.stringify({ hooks }, null, 2);
}

/**
 * Codex's TUI writes its session log as JSON lines. An awk filter follows the
 * log, keeps events sent to the TUI, and prints one line per new turn start or
 * approval request (deduplicated by turn or request id); each printed line is
 * forwarded through the hook.
 */
const CODEX_LOG_FILTER = `
function field(name,   at, rest) {
  at = index($0, "\\"" name "\\":\\"")
  if (!at) return ""
  rest = substr($0, at + length(name) + 4)
  return substr(rest, 1, index(rest, "\\"") - 1)
}
index($0, "\\"dir\\":\\"to_tui\\"") && index($0, "\\"kind\\":\\"codex_event\\"") {
  kind = field("type")
  if (kind == "task_started") {
    turn = field("turn_id"); if (turn == "") turn = "turn"
    if (turn != last_turn) { last_turn = turn; print "task_started"; fflush() }
  } else if (kind ~ /_approval_request$/) {
    ask = field("id"); if (ask == "") ask = field("approval_id"); if (ask == "") ask = field("call_id")
    if (ask == "") ask = "request-" (++anonymous)
    if (ask != last_ask) { last_ask = ask; print "approval_request"; fflush() }
  }
}`;

function buildCodexLogFollower(hookPath: string): string {
  return `codex_follower=""
if [ -n "\${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then
  (
    log="$CODEX_TUI_SESSION_LOG_PATH"
    tries=0
    while [ ! -f "$log" ] && [ "$tries" -lt 200 ]; do tries=$((tries + 1)); sleep 0.05; done
    [ -f "$log" ] || exit 0
    tail -n 0 -F "$log" 2>/dev/null | awk ${shellQuote(CODEX_LOG_FILTER)} | while IFS= read -r event; do
      ${shellQuote(hookPath)} "{\\"agent\\":\\"codex\\",\\"event\\":\\"$event\\"}" >/dev/null 2>&1 || true
    done
  ) &
  codex_follower=$!
fi`;
}

function buildWrapperScript(agent: ManagedTerminalAgentKind, realExecutable: string, hookPath: string, claudeSettingsPath: string): string {
  const real = shellQuote(realExecutable);
  const event = (name: string, exitCode = false) =>
    `aegis_osc '{"agent":"${agent}","event":"${name}"${exitCode ? `,"exitCode":'"$status"'}` : '}'}'`;
  const run =
    agent === 'claude'
      ? `${real} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : `${buildCodexLogFollower(hookPath)}
${real} "$@"`;
  const stopFollower =
    // The follower's pipeline (tail, awk, reader) are its children: stop them first.
    agent === 'codex'
      ? '[ -z "$codex_follower" ] || { pkill -P "$codex_follower" 2>/dev/null; kill "$codex_follower" 2>/dev/null; wait "$codex_follower" 2>/dev/null; }\n'
      : '';
  return `#!/bin/sh
# Aegis terminal wrapper for ${agent}: reports start and stop to the app.
[ "\${${WRAPPER_ENV_BYPASS}:-}" = 1 ] && exec ${real} "$@"
export ${WRAPPER_ENV_BYPASS}=1 AEGIS_TERMINAL_AGENT=${shellQuote(agent)} AEGIS_REAL_AGENT_CLI=${real}

${OSC_EMITTER}

${event('start')}
${run}
status=$?
${stopFollower}${event('stop', true)}
exit "$status"
`;
}

function buildZshEnvScript(basePath: string, userZdotDir: string, hookPath: string): string {
  return [
    `export PATH=${shellQuote(basePath)}:$PATH`,
    `export AEGIS_TERMINAL_OSC_HOOK=${shellQuote(hookPath)}`,
    'if [ -f "$HOME/.zshenv" ] && [ "${AEGIS_TERMINAL_SOURCED_USER_ZSHENV:-0}" != "1" ]; then',
    '  export AEGIS_TERMINAL_SOURCED_USER_ZSHENV=1',
    '  . "$HOME/.zshenv"',
    'fi',
    `export ZDOTDIR=${shellQuote(userZdotDir)}`,
    '',
  ].join('\n');
}

function buildZshRcScript(): string {
  return [
    'if [ -f "$HOME/.zshrc" ] && [ "${AEGIS_TERMINAL_SOURCED_USER_ZSHRC:-0}" != "1" ]; then',
    '  export AEGIS_TERMINAL_SOURCED_USER_ZSHRC=1',
    '  . "$HOME/.zshrc"',
    'fi',
    '',
  ].join('\n');
}

function getWrapperPaths(): {
  rootDir: string;
  binDir: string;
  zshDotDir: string;
  hookPath: string;
  claudeSettingsPath: string;
} {
  let userDataDir: string;
  try {
    userDataDir = app?.getPath ? app.getPath('userData') : join(tmpdir(), 'aegis');
  } catch {
    userDataDir = join(tmpdir(), 'aegis');
  }
  const rootDir = join(userDataDir, 'managed-terminal');
  const binDir = join(rootDir, 'bin');
  const zshDotDir = join(rootDir, 'zsh');
  return {
    rootDir,
    binDir,
    zshDotDir,
    hookPath: join(rootDir, 'aegis-terminal-osc-hook.sh'),
    claudeSettingsPath: join(rootDir, 'claude-settings.json'),
  };
}

export function prepareManagedTerminalEnvironment(baseEnv: Record<string, string>): ManagedTerminalEnvironment {
  if (process.platform === 'win32') {
    return {
      ok: true,
      env: baseEnv,
      launchCommands: {},
      message: 'Managed terminal wrappers are not available on Windows.',
    };
  }

  try {
    const { rootDir, binDir, zshDotDir, hookPath, claudeSettingsPath } = getWrapperPaths();
    ensurePrivateDirectory(rootDir);
    ensurePrivateDirectory(binDir);
    ensurePrivateDirectory(zshDotDir);

    writePrivateExecutable(hookPath, buildHookScript());

    const launchCommands: Partial<Record<ManagedTerminalAgentKind, string>> = {};
    for (const agent of ['claude', 'codex'] as ManagedTerminalAgentKind[]) {
      const realExecutable = resolveExecutableOnPath(agent, baseEnv, binDir);
      if (!realExecutable) continue;
      if (agent === 'claude') {
        writePrivateFile(claudeSettingsPath, buildClaudeSettingsJson(hookPath), 0o600);
      }
      const wrapperPath = join(binDir, agent);
      writePrivateExecutable(wrapperPath, buildWrapperScript(agent, realExecutable, hookPath, claudeSettingsPath));
      launchCommands[agent] = agent;
    }

    const pathWithWrappers = [binDir, baseEnv.PATH || process.env.PATH || ''].filter(Boolean).join(delimiter);
    writePrivateFile(join(zshDotDir, '.zshenv'), buildZshEnvScript(binDir, zshDotDir, hookPath), 0o600);
    writePrivateFile(join(zshDotDir, '.zshrc'), buildZshRcScript(), 0o600);

    return {
      ok: true,
      wrapperBinDir: binDir,
      zshDotDir,
      launchCommands,
      env: {
        ...baseEnv,
        PATH: pathWithWrappers,
        ZDOTDIR: zshDotDir,
        AEGIS_TERMINAL_OSC_HOOK: hookPath,
      },
    };
  } catch (error) {
    return {
      ok: false,
      env: baseEnv,
      launchCommands: {},
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function prepareManagedTerminalAgentLaunch(agent: ManagedTerminalAgentKind): {
  ok: boolean;
  command?: string;
  commandPath?: string;
  message?: string;
} {
  const prepared = prepareManagedTerminalEnvironment(
    Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  );
  if (!prepared.ok || !prepared.wrapperBinDir) {
    return { ok: false, message: prepared.message || 'Unable to prepare managed terminal wrapper.' };
  }
  const commandPath = join(prepared.wrapperBinDir, agent);
  if (!existsSync(commandPath)) {
    return { ok: false, message: `Could not find ${agent} on PATH.` };
  }
  return { ok: true, command: shellQuote(commandPath), commandPath };
}
