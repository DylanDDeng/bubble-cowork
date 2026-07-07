// Tests the Claude turn latency state machine, focused on the failure the
// review caught: a turn that ends before any output must not wedge the
// session's future measurement windows.

import assert from 'node:assert/strict';
import {
  markClaudePromptDispatched,
  markClaudeInit,
  markClaudeFirstOutput,
  clearClaudeTurnMetrics,
} from '../../src/electron/libs/claude-turn-metrics';

// Capture [ClaudeLatency] logs so we can assert which phases were recorded.
const logs: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.join(' ');
  if (line.includes('[ClaudeLatency]')) logs.push(line);
};

function reset() {
  logs.length = 0;
}

try {
  // ── A stuck window (no first output) must not block later windows ──────────
  {
    reset();
    const s = 'session-stuck';
    markClaudePromptDispatched(s, 'cold-start', false);
    markClaudeInit(s); // init logged, but first-output never arrives (stop/err)
    assert.equal(logs.some((l) => l.includes('init')), true, 'init logged for turn 1');

    // Without a reset, the next dispatch is refused (window still "open"),
    // so its init would never log. Clear simulates the terminal result/error.
    clearClaudeTurnMetrics(s);

    reset();
    markClaudePromptDispatched(s, 'warm-reuse', false);
    markClaudeInit(s);
    markClaudeFirstOutput(s);
    assert.equal(logs.some((l) => l.includes('init')), true, 'init logged for turn 2 after clear');
    assert.equal(
      logs.some((l) => l.includes('first-output')),
      true,
      'first-output logged for turn 2 after clear'
    );
  }

  // ── Guard still protects a live window from queued-prompt clobbering ────────
  {
    reset();
    const s = 'session-queued';
    markClaudePromptDispatched(s, 'cold-start', false);
    // A second dispatch while the first window is still waiting for output is
    // ignored, so the mode stays 'cold-start'.
    markClaudePromptDispatched(s, 'warm-reuse', false);
    markClaudeFirstOutput(s);
    const firstOutputLog = logs.find((l) => l.includes('first-output'));
    assert.ok(firstOutputLog, 'first-output logged');
    assert.equal(
      firstOutputLog!.includes('cold-start'),
      true,
      'live window is not clobbered by a queued dispatch'
    );
    clearClaudeTurnMetrics(s);
  }

  // ── After first-output, a new dispatch opens a fresh window ────────────────
  {
    reset();
    const s = 'session-sequential';
    markClaudePromptDispatched(s, 'cold-start', false);
    markClaudeFirstOutput(s);
    clearClaudeTurnMetrics(s);
    markClaudePromptDispatched(s, 'warm-reuse', false);
    markClaudeFirstOutput(s);
    const outputs = logs.filter((l) => l.includes('first-output'));
    assert.equal(outputs.length, 2, 'each turn records its own first-output');
    assert.equal(outputs[1].includes('warm-reuse'), true, 'second window uses the new mode');
  }

  // ── Queued fast follow-up: a dispatch after the current turn's first output
  //    opens a fresh window that survives until its OWN output. The ipc result
  //    handler only clears on drain, so turn 1's result must not wipe it — this
  //    verifies the metrics half: turn 2's dispatch is not blocked by turn 1's
  //    still-open-but-completed window. ─────────────────────────────────────
  {
    reset();
    const s = 'session-queued-followup';
    markClaudePromptDispatched(s, 'warm-reuse', false);
    markClaudeFirstOutput(s); // turn 1 first output
    // turn 2 queued before turn 1's result — must open its own window
    markClaudePromptDispatched(s, 'warm-reuse', false);
    markClaudeFirstOutput(s); // turn 2 first output — must log, not be swallowed
    const outputs = logs.filter((l) => l.includes('first-output'));
    assert.equal(outputs.length, 2, 'queued follow-up records its own first-output');
    clearClaudeTurnMetrics(s);
  }
} finally {
  console.log = originalLog;
}

console.log('claude-turn-metrics.test.ts passed');
