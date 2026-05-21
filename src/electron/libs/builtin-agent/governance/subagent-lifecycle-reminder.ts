/**
 * Subagent lifecycle reminder: injects active subagent status into the
 * system prompt so the parent agent is aware of its children.
 */

import type { SubagentThreadSnapshot } from './subagent-control';
import { isFinalSubagentStatus } from './subagent-control';

/**
 * Build the runtime reminder text to inject into the system prompt.
 * Returns "" when there are no subagents to report.
 */
export function buildSubagentLifecycleReminder(
  snapshots: SubagentThreadSnapshot[]
): string {
  if (snapshots.length === 0) return '';

  const running = snapshots.filter((s) => s.status === 'running');
  const final = snapshots.filter((s) => isFinalSubagentStatus(s.status));

  // No subagents at all
  if (running.length === 0 && final.length === 0) return '';

  const lines: string[] = [];

  lines.push('---');
  lines.push('## Subagent lifecycle truth');

  // Unique count
  const allIds = new Set(snapshots.map((s) => s.id));
  lines.push(`- Unique subagents currently tracked: ${allIds.size}.`);

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const s of snapshots) {
    statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  }
  const countPairs = Object.entries(statusCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  lines.push(`- Status counts: ${countPairs}.`);

  // Active agents
  if (running.length > 0) {
    lines.push('- Agents:');
    for (const s of running) {
      lines.push(
        `  - ${s.nickname} (${s.profile ?? 'agent'}) agent_id=${s.id} status=${s.status}`
      );
    }
  }

  // Completed agents
  if (final.length > 0) {
    for (const s of final) {
      const time =
        s.completedAt != null
          ? `${((Date.now() - s.completedAt) / 1000).toFixed(0)}s ago`
          : 'unknown';
      lines.push(
        `  - ${s.nickname} (${s.profile ?? 'agent'}) agent_id=${s.id} status=${s.status}${s.summary ? ` summary=${s.summary.slice(0, 120)}` : ''}${s.error ? ` error=${s.error.slice(0, 120)}` : ''} completed ${time}`
      );
    }
  }

  // Guidance
  lines.push('');
  lines.push(
    '- After spawn_agent, call wait_agent before user-facing progress ' +
      'narration unless you are doing concrete non-overlapping local work.'
  );
  lines.push(
    '- When writing a synthesis, use the exact unique subagent count and ' +
      'statuses above.'
  );

  // Warning for completed-but-unwaited subagents
  if (final.length > 0 && running.length === 0) {
    lines.push('');
    lines.push(
      '⚠ All subagents have completed. Use wait_agent to collect their results ' +
        'before reporting to the user.'
    );
  }

  return lines.join('\n');
}
