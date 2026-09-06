export const MAX_SESSION_TITLE_LENGTH = 200;

export function normalizeSessionTitleInput(value: string): string {
  if (typeof value !== 'string') throw new Error('Enter a conversation title.');
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Enter a conversation title.');
  if (title.length > MAX_SESSION_TITLE_LENGTH) {
    throw new Error(`Keep the title within ${MAX_SESSION_TITLE_LENGTH} characters.`);
  }
  return title;
}
