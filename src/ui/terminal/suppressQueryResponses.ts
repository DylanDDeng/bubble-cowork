const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

const QUERY_RESPONSE_PATTERNS = [
  /^\x1b\[\?1;2c$/,
  /^\x1b\[\?6c$/,
  /^\x1b\[\?2004[hl]$/,
];

export function suppressQueryResponses(data: string): boolean {
  if (data === FOCUS_IN || data === FOCUS_OUT) return true;
  return QUERY_RESPONSE_PATTERNS.some((pattern) => pattern.test(data));
}
