// Per-path serialized write queue (red-team C1: the hash-check→write TOCTOU
// window). Every mutation of a user source file goes through enqueue(); the
// job callback runs read-verify-write in the same tick, so no other queued
// writer for the same path can interleave.

type Job<T> = () => T | Promise<T>;

const tails = new Map<string, Promise<void>>();

export function enqueueFileWrite<T>(filePath: string, job: Job<T>): Promise<T> {
  const previous = tails.get(filePath) ?? Promise.resolve();
  const next = previous.then(job, job);
  const guarded = next.then(
    () => undefined,
    () => undefined
  );
  tails.set(filePath, guarded);
  void guarded.then(() => {
    if (tails.get(filePath) === guarded) tails.delete(filePath);
  });
  return next;
}

/** Test hook: wait for all in-flight writes to settle. */
export async function drainFileWrites(): Promise<void> {
  await Promise.all([...tails.values()]);
}
