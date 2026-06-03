import type {
  ManagedTerminalAgentKind,
  TerminalActivityState,
  TerminalAgentEventName,
} from './terminal';
import { terminalActivityStateFromAgentEvent as coerceActivityState } from './terminal';

const ESC = '\x1b';
const BEL = '\x07';
const C1_OSC = '\x9d';
const C1_ST = '\x9c';
const DEFAULT_MAX_PENDING_CONTROL_SEQUENCE = 8192;

export const AEGIS_TERMINAL_OSC_PREFIX = '633;AEGIS_AGENT_EVENT=';

export type TerminalOscState = {
  pendingControlSequence?: string;
};

export type TerminalOscActivityEvent = {
  agent: ManagedTerminalAgentKind;
  state: TerminalActivityState;
  event: TerminalAgentEventName;
  exitCode?: number | null;
};

export type TerminalOscParseResult = {
  output: string;
  activityEvents: TerminalOscActivityEvent[];
};

function findNextOsc(input: string, fromIndex: number): { index: number; markerLength: number } | null {
  const escOscIndex = input.indexOf(`${ESC}]`, fromIndex);
  const c1OscIndex = input.indexOf(C1_OSC, fromIndex);

  if (escOscIndex === -1 && c1OscIndex === -1) return null;
  if (escOscIndex === -1) return { index: c1OscIndex, markerLength: 1 };
  if (c1OscIndex === -1) return { index: escOscIndex, markerLength: 2 };
  return escOscIndex < c1OscIndex
    ? { index: escOscIndex, markerLength: 2 }
    : { index: c1OscIndex, markerLength: 1 };
}

function findOscTerminator(input: string, fromIndex: number): { index: number; length: number } | null {
  const candidates = [
    { index: input.indexOf(BEL, fromIndex), length: 1 },
    { index: input.indexOf(`${ESC}\\`, fromIndex), length: 2 },
    { index: input.indexOf(C1_ST, fromIndex), length: 1 },
  ].filter((candidate) => candidate.index !== -1);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
}

function coerceManagedAgent(value: unknown): ManagedTerminalAgentKind | null {
  return value === 'claude' || value === 'codex' ? value : null;
}

function coerceAgentEvent(value: unknown): TerminalAgentEventName | null {
  if (value === 'start' || value === 'stop' || value === 'permission-request' || value === 'review') {
    return value;
  }
  if (value === 'PermissionRequest') return 'permission-request';
  if (value === 'Start') return 'start';
  if (value === 'Stop') return 'stop';
  if (value === 'Review') return 'review';
  return null;
}

function stateForEvent(event: TerminalAgentEventName): TerminalActivityState {
  return coerceActivityState(event);
}

function parseAgentActivity(raw: string): TerminalOscActivityEvent | null {
  try {
    const payload = JSON.parse(raw) as {
      agent?: unknown;
      event?: unknown;
      exitCode?: unknown;
    };
    const agent = coerceManagedAgent(payload.agent);
    const event = coerceAgentEvent(payload.event);
    if (!agent || !event) return null;
    return {
      agent,
      event,
      state: stateForEvent(event),
      exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
    };
  } catch {
    return null;
  }
}

export function parseTerminalOsc(
  state: TerminalOscState,
  chunk: string,
  options?: {
    allowedAgent?: ManagedTerminalAgentKind | null;
    maxPendingControlSequence?: number;
    oscPrefix?: string;
  }
): TerminalOscParseResult {
  const maxPending = options?.maxPendingControlSequence ?? DEFAULT_MAX_PENDING_CONTROL_SEQUENCE;
  const oscPrefix = options?.oscPrefix ?? AEGIS_TERMINAL_OSC_PREFIX;
  const input = `${state.pendingControlSequence || ''}${chunk}`;
  state.pendingControlSequence = '';

  let output = '';
  let index = 0;
  const activityEvents: TerminalOscActivityEvent[] = [];

  while (index < input.length) {
    const nextOsc = findNextOsc(input, index);
    if (!nextOsc) {
      output += input.slice(index);
      break;
    }

    output += input.slice(index, nextOsc.index);
    const contentStart = nextOsc.index + nextOsc.markerLength;
    const terminator = findOscTerminator(input, contentStart);

    if (!terminator) {
      const pending = input.slice(nextOsc.index);
      if (pending.length <= maxPending) {
        state.pendingControlSequence = pending;
      } else {
        output += pending;
      }
      break;
    }

    const content = input.slice(contentStart, terminator.index);
    const fullSequence = input.slice(nextOsc.index, terminator.index + terminator.length);

    if (content.startsWith(oscPrefix)) {
      const event = parseAgentActivity(content.slice(oscPrefix.length));
      if (event && (!options?.allowedAgent || event.agent === options.allowedAgent)) {
        activityEvents.push(event);
      } else {
        output += fullSequence;
      }
    } else {
      output += fullSequence;
    }

    index = terminator.index + terminator.length;
  }

  return { output, activityEvents };
}
