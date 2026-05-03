export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /context[_ ]length[_ ]exceeded/i,
    /exceeds the context window/i,
    /maximum context length/i,
    /token limit/i,
    /context window/i,
  ].some((pattern) => pattern.test(message));
}

