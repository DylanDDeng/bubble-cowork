import type { BuiltinSkillAdapter, BuiltinToolRegistryEntry } from '../types';
import { asString } from './common';

function availableSkills(adapter: BuiltinSkillAdapter): string {
  return adapter.list().map((skill) => `${skill.name} (${skill.path})`).join(', ');
}

function missingSkillResult(adapter: BuiltinSkillAdapter, name: string) {
  const available = availableSkills(adapter);
  return {
    content: available
      ? `Error: Unknown skill "${name}". Available skills: ${available}`
      : `Error: Unknown skill "${name}". No skills are currently available.`,
    isError: true,
    status: 'no_match' as const,
  };
}

export function createSkillReadTool(adapter?: BuiltinSkillAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'skill_read',
    readOnly: true,
    description:
      'Read a skill SKILL.md by exact name or path. Use this after deciding a listed skill is needed for the current turn.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name to load.' },
        path: { type: 'string', description: 'The exact SKILL.md path to load.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const name = asString(args.name).trim();
      const path = asString(args.path).trim();
      if (!name && !path) return { content: 'Error: skill name or path is required', isError: true, status: 'command_error' };
      if (!adapter) return { content: 'Error: No skill adapter is configured.', isError: true, status: 'command_error' };
      const content = await adapter.load({ name, path });
      if (!content) return missingSkillResult(adapter, name || path);
      return { content, status: 'success', metadata: { kind: 'read', path: path || undefined } };
    },
  };
}

export function createSkillReadResourceTool(adapter?: BuiltinSkillAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'skill_read_resource',
    readOnly: true,
    description:
      'Read a specific file under a loaded skill directory, such as references/foo.md or scripts/foo.py. Do not bulk-load entire skill directories.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name.' },
        path: { type: 'string', description: 'The exact SKILL.md path.' },
        resource_path: { type: 'string', description: 'Relative path under the skill directory.' },
      },
      required: ['resource_path'],
      additionalProperties: false,
    },
    async execute(args) {
      const name = asString(args.name).trim();
      const path = asString(args.path).trim();
      const resourcePath = asString(args.resource_path).trim();
      if (!resourcePath) return { content: 'Error: resource_path is required', isError: true, status: 'command_error' };
      if (!name && !path) return { content: 'Error: skill name or path is required', isError: true, status: 'command_error' };
      if (!adapter?.readResource) return { content: 'Error: No skill resource adapter is configured.', isError: true, status: 'command_error' };
      const content = await adapter.readResource({ name, path, resourcePath });
      if (!content) return { content: `Error: Could not read skill resource "${resourcePath}".`, isError: true, status: 'no_match' };
      return { content, status: 'success', metadata: { kind: 'read', path: resourcePath } };
    },
  };
}

export function createSkillTool(adapter?: BuiltinSkillAdapter): BuiltinToolRegistryEntry {
  const readTool = createSkillReadTool(adapter);
  return {
    ...readTool,
    name: 'skill',
    description:
      'Compatibility wrapper for skill_read. Prefer skill_read for Codex-style progressive skill loading.',
  };
}
