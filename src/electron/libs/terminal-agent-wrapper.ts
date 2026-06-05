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

function buildHookScript(): string {
  return `#!/bin/sh
set -u

if [ "$#" -gt 0 ]; then
  _aegis_hook_input="$1"
else
  _aegis_hook_input="$(cat 2>/dev/null || true)"
fi

aegis_terminal_osc_event() {
  event="$1"
  if [ -e /dev/tty ]; then
    { printf '\\033]${OSC_PREFIX}%s\\007' "$event" > /dev/tty; } 2>/dev/null || printf '\\033]${OSC_PREFIX}%s\\007' "$event"
  else
    printf '\\033]${OSC_PREFIX}%s\\007' "$event"
  fi
}

_aegis_extract_json_string() {
  printf '%s' "$_aegis_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_aegis_agent="$(_aegis_extract_json_string agent)"
if [ -z "$_aegis_agent" ]; then
  _aegis_agent="\${AEGIS_TERMINAL_AGENT:-}"
fi
case "$_aegis_agent" in
  claude|codex) ;;
  *) exit 0 ;;
esac

_aegis_event="$(_aegis_extract_json_string hook_event_name)"
if [ -z "$_aegis_event" ]; then
  _aegis_event="$(_aegis_extract_json_string event)"
fi
if [ -z "$_aegis_event" ]; then
  _aegis_type="$(_aegis_extract_json_string type)"
  case "$_aegis_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _aegis_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _aegis_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _aegis_event="PermissionRequest"
      ;;
  esac
fi

case "$_aegis_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    aegis_terminal_osc_event '{"agent":"'"$_aegis_agent"'","event":"start"}'
    ;;
  Stop|SessionEnd)
    aegis_terminal_osc_event '{"agent":"'"$_aegis_agent"'","event":"stop"}'
    ;;
  PermissionRequest|PreToolUse|Notification)
    aegis_terminal_osc_event '{"agent":"'"$_aegis_agent"'","event":"permission-request"}'
    ;;
  Review)
    aegis_terminal_osc_event '{"agent":"'"$_aegis_agent"'","event":"review"}'
    ;;
esac

exit 0
`;
}

function buildClaudeSettingsJson(hookPath: string): string {
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
        PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
        Notification: [{ matcher: '*', hooks: [{ type: 'command', command: `AEGIS_TERMINAL_AGENT=claude ${shellQuote(hookPath)}` }] }],
      },
    },
    null,
    2
  );
}

function buildCodexLogWatcherScript(hookPath: string): string {
  return [
    'if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '  AEGIS_CODEX_WATCHER_PID=""',
    'else',
    '(',
    '  _aegis_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `  _aegis_hook=${shellQuote(hookPath)}`,
    '  _aegis_last_turn_id=""',
    '  _aegis_last_approval_id=""',
    '  _aegis_approval_fallback_seq=0',
    '  _aegis_emit_event() {',
    '    _aegis_event="$1"',
    '    _aegis_payload=$(printf \'{"agent":"codex","hook_event_name":"%s"}\' "$_aegis_event")',
    '    "$_aegis_hook" "$_aegis_payload" >/dev/null 2>&1 || true',
    '  }',
    '  _aegis_i=0',
    '  while [ ! -f "$_aegis_log" ] && [ "$_aegis_i" -lt 200 ]; do',
    '    _aegis_i=$((_aegis_i + 1))',
    '    sleep 0.05',
    '  done',
    '  if [ ! -f "$_aegis_log" ]; then',
    '    exit 0',
    '  fi',
    '  tail -n 0 -F "$_aegis_log" 2>/dev/null | while IFS= read -r _aegis_line; do',
    '    case "$_aegis_line" in',
    `      *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `        _aegis_turn_id=$(printf '%s\n' "$_aegis_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '        [ -n "$_aegis_turn_id" ] || _aegis_turn_id="task_started"',
    '        if [ "$_aegis_turn_id" != "$_aegis_last_turn_id" ]; then',
    '          _aegis_last_turn_id="$_aegis_turn_id"',
    '          _aegis_emit_event "Start"',
    '        fi',
    '        ;;',
    `      *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `        _aegis_approval_id=$(printf '%s\n' "$_aegis_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `        [ -n "$_aegis_approval_id" ] || _aegis_approval_id=$(printf '%s\n' "$_aegis_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `        [ -n "$_aegis_approval_id" ] || _aegis_approval_id=$(printf '%s\n' "$_aegis_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '        if [ -z "$_aegis_approval_id" ]; then',
    '          _aegis_approval_fallback_seq=$((_aegis_approval_fallback_seq + 1))',
    '          _aegis_approval_id="approval_request_${_aegis_approval_fallback_seq}"',
    '        fi',
    '        if [ "$_aegis_approval_id" != "$_aegis_last_approval_id" ]; then',
    '          _aegis_last_approval_id="$_aegis_approval_id"',
    '          _aegis_emit_event "PermissionRequest"',
    '        fi',
    '        ;;',
    '    esac',
    '  done',
    ') &',
    'AEGIS_CODEX_WATCHER_PID=$!',
    'fi',
  ].join('\n');
}

function buildWrapperScript(agent: ManagedTerminalAgentKind, realExecutable: string, hookPath: string, claudeSettingsPath: string): string {
  const agentJson = JSON.stringify(agent);
  const commandBody =
    agent === 'claude'
      ? `aegis_terminal_osc_event '{"agent":${agentJson},"event":"start"}'
${shellQuote(realExecutable)} --settings ${shellQuote(claudeSettingsPath)} "$@"
status=$?
aegis_terminal_osc_event '{"agent":${agentJson},"event":"stop","exitCode":'"$status"'}'
exit "$status"`
      : `${buildCodexLogWatcherScript(hookPath)}
aegis_terminal_osc_event '{"agent":${agentJson},"event":"start"}'
${shellQuote(realExecutable)} "$@"
status=$?
if [ -n "\${AEGIS_CODEX_WATCHER_PID:-}" ]; then
  kill "$AEGIS_CODEX_WATCHER_PID" >/dev/null 2>&1 || true
  wait "$AEGIS_CODEX_WATCHER_PID" 2>/dev/null || true
fi
aegis_terminal_osc_event '{"agent":${agentJson},"event":"stop","exitCode":'"$status"'}'
exit "$status"`;
  return `#!/bin/sh
if [ "$${WRAPPER_ENV_BYPASS}" = "1" ]; then
  exec ${shellQuote(realExecutable)} "$@"
fi

export ${WRAPPER_ENV_BYPASS}=1
export AEGIS_TERMINAL_AGENT=${shellQuote(agent)}
export AEGIS_REAL_AGENT_CLI=${shellQuote(realExecutable)}

aegis_terminal_osc_event() {
  event="$1"
  if [ -e /dev/tty ]; then
    { printf '\\033]${OSC_PREFIX}%s\\007' "$event" > /dev/tty; } 2>/dev/null || printf '\\033]${OSC_PREFIX}%s\\007' "$event"
  else
    printf '\\033]${OSC_PREFIX}%s\\007' "$event"
  fi
}

${commandBody}
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
