import { readFileSync } from 'fs';
import { relative, resolve, sep } from 'path';
import type { ProviderInputReference } from '../../../../shared/types';
import { findAegisSkill } from './registry';
import type { AegisSkillDescriptor, AegisSkillLoadOutcome } from './types';

const MAX_SKILL_BODY_CHARS = 80_000;
const MAX_RESOURCE_CHARS = 60_000;

function truncateMiddle(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head - 96;
  return {
    text: `${value.slice(0, head).trimEnd()}\n\n...[${value.length - head - tail} chars omitted from skill content]...\n\n${value.slice(-tail).trimStart()}`,
    truncated: true,
  };
}

function readTextFileBounded(path: string, maxChars: number): { text: string; truncated: boolean } {
  const buffer = readFileSync(path);
  if (buffer.includes(0)) {
    throw new Error('skill file appears to be binary');
  }
  return truncateMiddle(buffer.toString('utf-8'), maxChars);
}

export function formatSkillInstructions(skill: AegisSkillDescriptor, contents: string): string {
  return [
    '<skill>',
    `<name>${skill.name}</name>`,
    `<path>${skill.path}</path>`,
    contents.trim(),
    '</skill>',
  ].join('\n');
}

export function readSkillInstructions(skill: AegisSkillDescriptor): string {
  const contents = readTextFileBounded(skill.path, MAX_SKILL_BODY_CHARS);
  return formatSkillInstructions(
    skill,
    contents.truncated
      ? `${contents.text}\n\nNote: SKILL.md was truncated. Use skill_read_resource for specific referenced files if needed.`
      : contents.text
  );
}

export function buildSkillInjections(
  outcome: AegisSkillLoadOutcome,
  references?: ProviderInputReference[]
): { prompt: string; warnings: string[] } {
  if (!references?.length) return { prompt: '', warnings: [] };
  const blocks: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const skill = findAegisSkill(outcome, { name: reference.name, path: reference.path });
    if (!skill) {
      warnings.push(`Failed to load selected skill ${reference.name || reference.path}: no matching local skill was found.`);
      continue;
    }
    if (seen.has(skill.path)) continue;
    seen.add(skill.path);
    try {
      blocks.push(readSkillInstructions(skill));
    } catch (error) {
      warnings.push(
        `Failed to read selected skill ${skill.name} at ${skill.path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    prompt: blocks.join('\n\n'),
    warnings,
  };
}

export function collectImplicitSkillReferences(
  outcome: AegisSkillLoadOutcome,
  text: string
): ProviderInputReference[] {
  const names = new Set<string>();
  const pattern = /\$([A-Za-z0-9_:-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    names.add(match[1]);
  }
  if (names.size === 0) return [];
  return outcome.skills
    .filter((skill) => skill.policy?.allowImplicitInvocation !== false && names.has(skill.name))
    .map((skill) => ({ name: skill.name, path: skill.path }));
}

export function resolveSkillResourcePath(skill: AegisSkillDescriptor, relativePath: string): string | null {
  const normalized = relativePath.trim();
  if (!normalized || normalized.includes('\0')) return null;
  const root = skill.skillDir;
  const candidate = resolve(root, normalized);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  return candidate;
}

export function readSkillResourceFile(path: string): { text: string; truncated: boolean } {
  return readTextFileBounded(path, MAX_RESOURCE_CHARS);
}
