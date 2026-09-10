import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeGoalController, type ClaudeGoalState } from './claude-goal';

const controllers = new Map<string, ClaudeGoalController>();
const events = new EventEmitter();
const directory = () => join(app.getPath('userData'), 'claude-goals');
const statePath = (id: string) =>
  join(directory(), `${createHash('sha256').update(id).digest('hex')}.json`);
export function readClaudeGoalState(id: string): ClaudeGoalState {
  const active = controllers.get(id);
  if (active) return active.snapshot;
  try {
    const saved = JSON.parse(readFileSync(statePath(id), 'utf8')) as ClaudeGoalState;
    if (!saved || typeof saved.supported !== 'boolean') throw new Error('Invalid goal state');
    if (saved.goal && (saved.goal.threadId !== id || typeof saved.goal.objective !== 'string'))
      throw new Error('Invalid goal');
    if (saved.goal?.status === 'active') {
      saved.goal.status = 'paused';
      saved.resumeConfirmation = true;
    }
    return saved;
  } catch {
    return { goal: null, supported: true };
  }
}
function save(id: string, state: ClaudeGoalState) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const target = statePath(id);
  writeFileSync(target + '.tmp', JSON.stringify(state), { mode: 0o600 });
  renameSync(target + '.tmp', target);
}
export function createClaudeGoalController(id: string, resumed: boolean) {
  const initial = readClaudeGoalState(id);
  const controller = new ClaudeGoalController({
    sessionId: id,
    resumed,
    initial,
    storageDir: join(directory(), 'objectives', createHash('sha256').update(id).digest('hex')),
    publish(state) {
      if (controllers.get(id) !== controller) return;
      save(id, state);
      events.emit('change', id, state);
    },
  });
  controllers.set(id, controller);
  return controller;
}
export function releaseClaudeGoalController(
  id: string,
  controller: ClaudeGoalController,
  error?: Error,
) {
  controller.dispose(error);
  if (controllers.get(id) === controller) controllers.delete(id);
  if (error) events.emit('failure', id, error);
}
export function getClaudeGoalController(id: string) {
  return controllers.get(id);
}
export function onClaudeGoalChanged(listener: (id: string, state: ClaudeGoalState) => void) {
  events.on('change', listener);
  return () => events.off('change', listener);
}
export function removeClaudeGoalState(id: string) {
  rmSync(statePath(id), { force: true });
}

/** Subscribe before dispatch; only a native acknowledgement resolves the action. */
export async function awaitClaudeGoalSet(
  id: string,
  objective: string,
  dispatch: () => Promise<unknown>,
) {
  const previousActivation = readClaudeGoalState(id).activationId;
  return new Promise<ClaudeGoalState>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = (error?: Error, state?: ClaudeGoalState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.off('change', changed);
      events.off('failure', failed);
      error ? reject(error) : resolve(state!);
    };
    const changed = (key: string, state: ClaudeGoalState) => {
      if (key !== id) return;
      if (!state.supported) finish(new Error('This Claude Code version does not support /goal.'));
      else if (
        state.activationId !== previousActivation &&
        state.goal?.status === 'active' &&
        (state.goal.displayObjective ?? state.goal.objective) === objective
      )
        finish(undefined, state);
    };
    const failed = (key: string, error: Error) => {
      if (key === id) finish(error);
    };
    events.on('change', changed);
    events.on('failure', failed);
    timer = setTimeout(() => {
      const error = new Error('Claude did not confirm setting the goal.');
      finish(error);
      // A delayed set must never start pursuing after the UI reported failure.
      const controller = controllers.get(id);
      controller?.cancelPendingStart(error);
    }, 30_000);
    void dispatch().catch((error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}
export function rejectClaudeGoalSet(id: string, error: Error) {
  events.emit('failure', id, error);
}
