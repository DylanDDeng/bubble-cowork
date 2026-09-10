import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const prefix = 'Read the complete goal objective from ';
const suffix = ' before continuing.';
const directory = () =>
  process.env.AEGIS_GOAL_OBJECTIVES_DIR || join(app.getPath('userData'), 'goal-objectives');

export function materializeGoalObjective(objective: string): {
  objective: string;
  discard: () => void;
} {
  if (Array.from(objective).length <= 4000) return { objective, discard() {} };
  const root = directory();
  mkdirSync(root, { recursive: true });
  const path = join(root, `${randomUUID()}.md`);
  writeFileSync(path, objective, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return {
    objective: `${prefix}${path}${suffix}`,
    discard: () => {
      try {
        unlinkSync(path);
      } catch {
        /* failed request cleanup */
      }
    },
  };
}

/** Only resolve references created by this app; a model's arbitrary path is never read by the UI. */
export function readGoalObjective(objective: string): string | undefined {
  if (!objective.startsWith(prefix) || !objective.endsWith(suffix)) return undefined;
  const path = objective.slice(prefix.length, -suffix.length);
  if (!/^[\da-f-]{36}\.md$/.test(basename(path)) || dirname(path) !== directory()) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
