import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ClaudeSkillSummary } from '../../shared/types';

const USER_SKILLS_ROOT = join(homedir(), '.claude', 'skills');

function formatFallbackTitle(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseSkillMetadata(
  skillFilePath: string,
  fallbackName: string
): Pick<ClaudeSkillSummary, 'title' | 'description'> {
  try {
    const content = readFileSync(skillFilePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    let title = formatFallbackTitle(fallbackName);
    const descriptionLines: string[] = [];
    let sawHeading = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!sawHeading) {
        const headingMatch = line.match(/^#\s+(.+)$/);
        if (headingMatch) {
          title = headingMatch[1].trim();
          sawHeading = true;
        }
        continue;
      }

      if (!line) {
        if (descriptionLines.length > 0) {
          break;
        }
        continue;
      }

      if (line.startsWith('#')) {
        if (descriptionLines.length > 0) {
          break;
        }
        continue;
      }

      descriptionLines.push(line);
    }

    const description = descriptionLines.join(' ').trim() || undefined;
    return { title, description };
  } catch {
    return { title: formatFallbackTitle(fallbackName) };
  }
}

function listSkillsInRoot(
  rootPath: string | undefined,
  source: ClaudeSkillSummary['source']
): ClaudeSkillSummary[] {
  if (!rootPath || !existsSync(rootPath)) {
    return [];
  }

  try {
    const skills: ClaudeSkillSummary[] = [];

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillFilePath = join(rootPath, entry.name, 'SKILL.md');
      if (!existsSync(skillFilePath)) {
        continue;
      }

      const metadata = parseSkillMetadata(skillFilePath, entry.name);
      skills.push({
        name: entry.name,
        title: metadata.title,
        description: metadata.description,
        path: skillFilePath,
        source,
      });
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function listClaudeSkills(projectPath?: string): {
  userRoot: string;
  projectRoot?: string;
  userSkills: ClaudeSkillSummary[];
  projectSkills: ClaudeSkillSummary[];
} {
  const projectRoot = projectPath ? join(projectPath, '.claude', 'skills') : undefined;

  return {
    userRoot: USER_SKILLS_ROOT,
    projectRoot,
    userSkills: listSkillsInRoot(USER_SKILLS_ROOT, 'user'),
    projectSkills: listSkillsInRoot(projectRoot, 'project'),
  };
}
