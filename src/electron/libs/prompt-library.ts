import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  PromptLibraryExportResult,
  PromptLibraryFile,
  PromptLibraryImportResult,
  PromptLibraryItem,
  UpsertPromptLibraryItemInput,
} from '../../shared/types';

const PROMPT_LIBRARY_PATH = () => join(app.getPath('userData'), 'prompt-library.json');

function getDefaultPromptLibraryFile(): PromptLibraryFile {
  return {
    version: 1,
    prompts: [],
  };
}

function sortPromptItems(items: PromptLibraryItem[]): PromptLibraryItem[] {
  return [...items].sort((left, right) =>
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    left.title.localeCompare(right.title)
  );
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizePromptItem(
  value: Partial<PromptLibraryItem> & Pick<PromptLibraryItem, 'title' | 'content'>,
  fallbackNow = Date.now()
): PromptLibraryItem | null {
  const title = value.title.trim();
  const content = value.content.trim();
  if (!title || !content) {
    return null;
  }

  return {
    id: typeof value.id === 'string' && value.id.trim() ? value.id : uuidv4(),
    title,
    content,
    tags: normalizeTags(value.tags),
    description: value.description?.trim() || undefined,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : fallbackNow,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : fallbackNow,
  };
}

function savePromptLibraryFile(file: PromptLibraryFile): void {
  writeFileSync(PROMPT_LIBRARY_PATH(), JSON.stringify({ version: 1, prompts: sortPromptItems(file.prompts) }, null, 2));
}

function loadPromptLibraryFile(): PromptLibraryFile {
  const filePath = PROMPT_LIBRARY_PATH();
  if (!existsSync(filePath)) {
    return getDefaultPromptLibraryFile();
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PromptLibraryFile>;
    const prompts = Array.isArray(parsed.prompts)
      ? parsed.prompts
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return null;
            }

            const value = item as Partial<PromptLibraryItem> & Pick<PromptLibraryItem, 'title' | 'content'>;
            if (typeof value.title !== 'string' || typeof value.content !== 'string') {
              return null;
            }
            return normalizePromptItem(value);
          })
          .filter((item): item is PromptLibraryItem => Boolean(item))
      : [];

    return {
      version: 1,
      prompts: sortPromptItems(prompts),
    };
  } catch {
    return getDefaultPromptLibraryFile();
  }
}

function promptDedupKey(item: Pick<PromptLibraryItem, 'title' | 'content'>): string {
  return `${item.title.trim().toLowerCase()}\u0000${item.content.trim()}`;
}

export function listPromptLibraryItems(): PromptLibraryItem[] {
  return loadPromptLibraryFile().prompts;
}

export function savePromptLibraryItem(input: UpsertPromptLibraryItemInput): PromptLibraryItem[] {
  const file = loadPromptLibraryFile();
  const now = Date.now();
  const normalized = normalizePromptItem({
    id: input.id,
    title: input.title,
    content: input.content,
    tags: input.tags,
    description: input.description,
    updatedAt: now,
    createdAt: now,
  });

  if (!normalized) {
    throw new Error('Prompt title and content are required.');
  }

  const existingIndex = input.id ? file.prompts.findIndex((item) => item.id === input.id) : -1;
  if (existingIndex >= 0) {
    const existing = file.prompts[existingIndex];
    file.prompts[existingIndex] = {
      ...existing,
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  } else {
    file.prompts.push(normalized);
  }

  savePromptLibraryFile(file);
  return listPromptLibraryItems();
}

export function deletePromptLibraryItem(id: string): PromptLibraryItem[] {
  const file = loadPromptLibraryFile();
  file.prompts = file.prompts.filter((item) => item.id !== id);
  savePromptLibraryFile(file);
  return listPromptLibraryItems();
}

export function importPromptLibraryFile(filePath: string): PromptLibraryImportResult {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as { prompts?: unknown } | unknown[];
  const importedValues = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { prompts?: unknown }).prompts)
      ? (parsed as { prompts: unknown[] }).prompts
      : [];

  const file = loadPromptLibraryFile();
  const existingKeys = new Set(file.prompts.map((item) => promptDedupKey(item)));
  let importedCount = 0;
  let skippedCount = 0;

  for (const value of importedValues) {
    if (!value || typeof value !== 'object') {
      skippedCount += 1;
      continue;
    }

    const candidate = value as Partial<PromptLibraryItem> & { title?: unknown; content?: unknown };
    if (typeof candidate.title !== 'string' || typeof candidate.content !== 'string') {
      skippedCount += 1;
      continue;
    }

    const normalized = normalizePromptItem({
      title: candidate.title,
      content: candidate.content,
      tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      description: typeof candidate.description === 'string' ? candidate.description : undefined,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    });

    if (!normalized) {
      skippedCount += 1;
      continue;
    }

    const key = promptDedupKey(normalized);
    if (existingKeys.has(key)) {
      skippedCount += 1;
      continue;
    }

    existingKeys.add(key);
    file.prompts.push(normalized);
    importedCount += 1;
  }

  savePromptLibraryFile(file);

  return {
    items: listPromptLibraryItems(),
    importedCount,
    skippedCount,
    filePath,
  };
}

export function exportPromptLibraryFile(filePath: string): PromptLibraryExportResult {
  const prompts = listPromptLibraryItems();
  writeFileSync(filePath, JSON.stringify({ version: 1, prompts }, null, 2));
  return {
    canceled: false,
    filePath,
    count: prompts.length,
  };
}
