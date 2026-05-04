import { readFile } from 'fs/promises';
import type { BuiltinSkillAdapter } from '../types';
import { findAegisSkill } from '../skills/registry';
import { getAegisSkills } from '../skills/manager';
import { formatSkillInstructions, readSkillResourceFile, resolveSkillResourcePath } from '../skills/injection';

export function createAegisSkillAdapter(projectPath?: string): BuiltinSkillAdapter {
  const cwd = projectPath || process.cwd();
  return {
    list: () =>
      getAegisSkills(cwd).outcome.skills.map((skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        path: skill.path,
        root: skill.root,
        scope: skill.scope,
      })),
    async load(input): Promise<string | null> {
      const outcome = getAegisSkills(cwd).outcome;
      const skill = findAegisSkill(outcome, input);
      if (!skill) return null;
      const content = await readFile(skill.path, 'utf-8');
      return formatSkillInstructions(skill, content);
    },
    async readResource(input): Promise<string | null> {
      const outcome = getAegisSkills(cwd).outcome;
      const skill = findAegisSkill(outcome, input);
      if (!skill) return null;
      const resource = resolveSkillResourcePath(skill, input.resourcePath);
      if (!resource) return null;
      const content = readSkillResourceFile(resource);
      return [
        `Skill resource: ${skill.name}`,
        `Base file: ${skill.path}`,
        `Resource: ${resource}`,
        content.truncated ? 'Note: resource was truncated to fit the skill resource read budget.' : '',
        '',
        content.text.trim(),
      ].filter(Boolean).join('\n');
    },
  };
}
