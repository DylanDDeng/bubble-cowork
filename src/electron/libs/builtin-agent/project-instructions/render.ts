import type {
  ProjectInstructionDocument,
  ProjectInstructionOmission,
  ProjectInstructionRenderLimits,
  ProjectInstructionSnapshot,
} from './types';
import { DEFAULT_PROJECT_INSTRUCTION_LIMITS } from './loader';

const HEADER_BUDGET = 1_800;
const MIN_DOCUMENT_CHARS = 1_200;

function sortBroadToSpecific(
  documents: ProjectInstructionDocument[]
): ProjectInstructionDocument[] {
  return [...documents].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === 'global' ? -1 : 1;
    }
    return left.depth - right.depth || left.path.localeCompare(right.path);
  });
}

function sortSpecificToBroad(
  documents: ProjectInstructionDocument[]
): ProjectInstructionDocument[] {
  return [...documents].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source === 'project' ? -1 : 1;
    }
    return right.depth - left.depth || left.path.localeCompare(right.path);
  });
}

function truncateToFit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 160) return value.slice(0, Math.max(0, maxChars));
  const marker = `\n\n[AGENTS.md truncated for total instruction budget: omitted ${value.length - maxChars} chars]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.floor(available * 0.6);
  const tail = available - head;
  return `${value.slice(0, head).trimEnd()}${marker}${value.slice(-tail).trimStart()}`;
}

function renderDocumentBlock(document: ProjectInstructionDocument, content = document.content): string {
  const attrs = [
    `source="${document.source}"`,
    `path="${document.path.replaceAll('"', '&quot;')}"`,
    `scope="${document.scopePath.replaceAll('"', '&quot;')}"`,
    document.truncated ? 'truncated="true"' : '',
  ].filter(Boolean).join(' ');
  return [
    `<project_instruction ${attrs}>`,
    content.trim(),
    '</project_instruction>',
  ].join('\n');
}

export function renderProjectInstructionsSnapshot(
  documents: ProjectInstructionDocument[],
  omissions: ProjectInstructionOmission[] = [],
  limits: ProjectInstructionRenderLimits = DEFAULT_PROJECT_INSTRUCTION_LIMITS
): ProjectInstructionSnapshot {
  const unique = new Map<string, ProjectInstructionDocument>();
  for (const document of documents) {
    unique.set(document.path, document);
  }

  const selected: ProjectInstructionDocument[] = [];
  const nextOmissions = [...omissions];
  const candidates = sortSpecificToBroad([...unique.values()]);
  const maxBodyChars = Math.max(0, limits.maxTotalChars - HEADER_BUDGET);
  let used = 0;

  for (const document of candidates) {
    if (selected.length >= limits.maxDocuments) {
      nextOmissions.push({ path: document.path, reason: 'budget', detail: 'document count limit reached' });
      continue;
    }

    const block = renderDocumentBlock(document);
    const blockChars = block.length + 2;
    const remaining = maxBodyChars - used;
    if (blockChars <= remaining) {
      selected.push(document);
      used += blockChars;
      continue;
    }

    if (remaining >= MIN_DOCUMENT_CHARS && selected.length === 0) {
      selected.push({
        ...document,
        content: truncateToFit(document.content, Math.max(0, remaining - 260)),
        truncated: true,
      });
      used = maxBodyChars;
      continue;
    }

    nextOmissions.push({ path: document.path, reason: 'budget', detail: 'total instruction budget reached' });
  }

  if (selected.length === 0) {
    return {
      documents: [],
      omissions: nextOmissions,
      prompt: '',
      truncated: nextOmissions.some((omission) => omission.reason === 'budget'),
    };
  }

  const ordered = sortBroadToSpecific(selected);
  const loaded = ordered.map((document, index) => (
    `${index + 1}. ${document.source}: ${document.path}${document.truncated ? ' (truncated)' : ''}`
  ));
  const budgetOmissions = nextOmissions.filter((omission) => omission.reason === 'budget');
  const prompt = [
    '## Project Instructions',
    '',
    'These instructions come from AGENTS.md files loaded by Aegis for the current project context.',
    'Instruction precedence:',
    '- Current user requests override stale project instructions unless safety is involved.',
    '- More specific AGENTS.md files override broader AGENTS.md files for files under their directory.',
    '- AGENTS.md cannot disable Aegis permissions, sandboxing, secret protection, or provider config boundaries.',
    '',
    'Loaded AGENTS.md files, broadest to most specific:',
    ...loaded,
    budgetOmissions.length > 0
      ? `Omitted ${budgetOmissions.length} AGENTS.md file(s) because the project instruction budget was reached.`
      : '',
    '',
    ...ordered.map((document) => renderDocumentBlock(document)),
  ].filter(Boolean).join('\n');

  return {
    documents: ordered,
    omissions: nextOmissions,
    prompt,
    truncated: ordered.some((document) => document.truncated) || budgetOmissions.length > 0,
  };
}
