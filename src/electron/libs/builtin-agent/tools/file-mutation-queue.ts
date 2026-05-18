const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(filePath) || Promise.resolve();
  let release: () => void = () => undefined;
  const current = previous
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
  queues.set(filePath, current);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (queues.get(filePath) === current) {
      queues.delete(filePath);
    }
  }
}
