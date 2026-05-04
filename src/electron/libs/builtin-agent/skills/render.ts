import type { AegisRenderedSkills, AegisSkillDescriptor, AegisSkillLoadOutcome } from './types';

const DEFAULT_METADATA_CHAR_BUDGET = 8_000;
const METADATA_CONTEXT_WINDOW_PERCENT = 2;

const HOW_TO_USE_SKILLS = `- Discovery: The list above is the skills available in this session (name + description + short path). Skill bodies live on disk at the listed paths after expanding the matching alias from \`### Skill roots\`.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned or still directly needed for the same user request.
- Missing/blocked: If a named skill cannot be loaded, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1. After deciding to use a skill, call \`skill_read\` for that skill. Read only enough to follow the workflow.
  2. When \`SKILL.md\` references relative paths such as \`scripts/foo.py\`, resolve them relative to the skill file directory first.
  3. If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed with \`skill_read_resource\`; do not bulk-load an entire skill directory.
  4. If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks, using normal permission rules for command execution.
  5. If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Context hygiene: Keep context small, summarize long references, and avoid deep reference-chasing unless blocked.
- Safety and fallback: Skill resources are local files. Never execute skill scripts implicitly; use normal tools and permission flow.`;

function metadataBudget(contextWindow?: number): number {
  if (contextWindow && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(1, Math.floor(contextWindow * METADATA_CONTEXT_WINDOW_PERCENT / 100) * 4);
  }
  return DEFAULT_METADATA_CHAR_BUDGET;
}

function renderPath(skill: AegisSkillDescriptor, aliases: Map<string, string>): string {
  const alias = aliases.get(skill.root);
  return alias ? `${alias}/${skill.relativePath}` : skill.path;
}

function lineCost(line: string): number {
  return line.length + 1;
}

function fullLine(skill: AegisSkillDescriptor, path: string, descriptionOverride?: string): string {
  const description = descriptionOverride ?? skill.description;
  return `- ${skill.name}: ${description || 'No description available.'} (file: ${path})`;
}

function minimumLine(skill: AegisSkillDescriptor, path: string): string {
  return `- ${skill.name}: (file: ${path})`;
}

function buildAliases(skills: AegisSkillDescriptor[]): { aliases: Map<string, string>; rootLines: string[] } {
  const roots = Array.from(new Set(skills.map((skill) => skill.root))).sort();
  const aliases = new Map<string, string>();
  const rootLines = roots.map((root, index) => {
    const alias = `r${index}`;
    aliases.set(root, alias);
    return `- \`${alias}\` = \`${root}\``;
  });
  return { aliases, rootLines };
}

function renderSkillLines(
  skills: AegisSkillDescriptor[],
  aliases: Map<string, string>,
  budget: number,
  fixedOverhead: number
): {
  lines: string[];
  omittedCount: number;
  truncatedDescriptionChars: number;
} {
  let remaining = Math.max(0, budget - fixedOverhead);
  const fullLines = skills.map((skill) => fullLine(skill, renderPath(skill, aliases)));
  const fullCost = fullLines.reduce((sum, line) => sum + lineCost(line), 0);
  if (fullCost <= remaining) {
    return { lines: fullLines, omittedCount: 0, truncatedDescriptionChars: 0 };
  }

  const minimumLines = skills.map((skill) => minimumLine(skill, renderPath(skill, aliases)));
  const minimumCost = minimumLines.reduce((sum, line) => sum + lineCost(line), 0);
  if (minimumCost > remaining) {
    const lines: string[] = [];
    let omittedCount = 0;
    let truncatedDescriptionChars = 0;
    for (let index = 0; index < skills.length; index += 1) {
      const line = minimumLines[index];
      if (remaining >= lineCost(line)) {
        lines.push(line);
        remaining -= lineCost(line);
      } else {
        omittedCount += 1;
      }
      truncatedDescriptionChars += skills[index].description.length;
    }
    return { lines, omittedCount, truncatedDescriptionChars };
  }

  const extraBudget = remaining - minimumCost;
  const totalDescriptionChars = skills.reduce((sum, skill) => sum + skill.description.length, 0);
  const lines: string[] = [];
  let truncatedDescriptionChars = 0;
  for (const skill of skills) {
    const path = renderPath(skill, aliases);
    if (!skill.description) {
      lines.push(fullLine(skill, path, ''));
      continue;
    }
    const share =
      totalDescriptionChars > 0
        ? Math.max(0, Math.floor(extraBudget * skill.description.length / totalDescriptionChars))
        : 0;
    const allowedDescriptionChars = Math.min(skill.description.length, share);
    const description =
      allowedDescriptionChars >= skill.description.length
        ? skill.description
        : `${skill.description.slice(0, Math.max(0, allowedDescriptionChars - 1)).trimEnd()}…`;
    truncatedDescriptionChars += Math.max(0, skill.description.length - description.length);
    lines.push(fullLine(skill, path, description));
  }
  return { lines, omittedCount: 0, truncatedDescriptionChars };
}

export function renderAvailableSkills(
  outcome: AegisSkillLoadOutcome,
  options?: { contextWindow?: number }
): AegisRenderedSkills | null {
  const skills = outcome.skills.filter((skill) => skill.policy?.allowImplicitInvocation !== false);
  if (skills.length === 0) return null;
  const { aliases, rootLines } = buildAliases(skills);
  const budget = metadataBudget(options?.contextWindow);
  const headerLines = [
    '## Skills',
    'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.',
    '### Skill roots',
    ...rootLines,
    '### Available skills',
  ];
  const footerLines = ['### How to use skills', HOW_TO_USE_SKILLS];
  const fixedOverhead = [...headerLines, ...footerLines].reduce((sum, line) => sum + lineCost(line), 0);
  const rendered = renderSkillLines(skills, aliases, budget, fixedOverhead);
  const prompt = ['', ...headerLines, ...rendered.lines, ...footerLines, ''].join('\n');
  const warning =
    rendered.omittedCount > 0
      ? `Exceeded skills context budget. ${rendered.omittedCount} additional skill(s) were not included in the model-visible skills list.`
      : rendered.truncatedDescriptionChars > 0
        ? 'Skill descriptions were shortened to fit the skills context budget. The agent can still load full SKILL.md files when needed.'
        : undefined;
  return {
    prompt,
    warning,
    report: {
      totalCount: skills.length,
      includedCount: rendered.lines.length,
      omittedCount: rendered.omittedCount,
      truncatedDescriptionChars: rendered.truncatedDescriptionChars,
    },
  };
}
