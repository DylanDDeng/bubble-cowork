import type { BuiltinSkillAdapter, BuiltinToolRegistryEntry } from '../types';
import { asString } from './common';

export function createSkillTool(adapter?: BuiltinSkillAdapter): BuiltinToolRegistryEntry {
  return {
    name: 'skill',
    readOnly: true,
    description: 'Load a named skill on demand. Use this when a task clearly matches one of the available skills.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact skill name to load.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args) {
      const name = asString(args.name).trim();
      if (!name) return { content: 'Error: skill name is required', isError: true, status: 'command_error' };
      if (!adapter) return { content: 'Error: No skill adapter is configured.', isError: true, status: 'command_error' };
      const content = await adapter.load(name);
      if (!content) {
        const available = adapter.list().map((skill) => skill.name).join(', ');
        return {
          content: available ? `Error: Unknown skill "${name}". Available skills: ${available}` : `Error: Unknown skill "${name}". No skills are currently available.`,
          isError: true,
          status: 'no_match',
        };
      }
      return { content, status: 'success', metadata: { kind: 'read' } };
    },
  };
}

