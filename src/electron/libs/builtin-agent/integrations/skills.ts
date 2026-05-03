import { readFile } from 'fs/promises';
import type { BuiltinSkillAdapter } from '../types';
import { listClaudeSkills } from '../../claude-skills';

export function createAegisSkillAdapter(projectPath?: string): BuiltinSkillAdapter {
  return {
    list: () => [
      ...listClaudeSkills(projectPath).projectSkills,
      ...listClaudeSkills(projectPath).userSkills,
    ],
    async load(name: string): Promise<string | null> {
      const skills = [
        ...listClaudeSkills(projectPath).projectSkills,
        ...listClaudeSkills(projectPath).userSkills,
      ];
      const skill = skills.find((item) => item.name === name || item.title === name);
      if (!skill) return null;
      const content = await readFile(skill.path, 'utf-8');
      return [
        `Skill: ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : '',
        `Base file: ${skill.path}`,
        '',
        content.trim(),
        '',
        'Relative paths mentioned in this skill are resolved from the skill file directory above.',
      ].filter(Boolean).join('\n');
    },
  };
}

