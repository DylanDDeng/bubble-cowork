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
    const frontmatter = parseFrontmatter(content);
    const body = frontmatter ? content.slice(frontmatter.bodyStartIndex) : content;
    const lines = body.split(/\r?\n/);
    let title = frontmatter?.title || formatFallbackTitle(fallbackName);
    let description = frontmatter?.description;
    const descriptionLines: string[] = [];
    let sawHeading = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!sawHeading) {
        const headingMatch = line.match(/^#\s+(.+)$/);
        if (headingMatch) {
          if (!frontmatter?.title) {
            title = headingMatch[1].trim();
          }
          sawHeading = true;
          if (description) {
            break;
          }
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

      if (!description) {
        descriptionLines.push(line);
      }
    }

    if (!description) {
      description = descriptionLines.join(' ').trim() || undefined;
    }
    return { title, description };
  } catch {
    return { title: formatFallbackTitle(fallbackName) };
  }
}

function parseFrontmatter(content: string): {
  title?: string;
  description?: string;
  bodyStartIndex: number;
} | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return null;
  }

  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterText = normalized.slice(4, endIndex);
  const lines = frontmatterText.split('\n');
  const fields = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const fieldMatch = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }

    const key = fieldMatch[1].toLowerCase();
    let value = fieldMatch[2].trim();

    if (value === '>' || value === '|') {
      const folded: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        if (!/^\s+/.test(nextLine)) {
          break;
        }
        index += 1;
        folded.push(nextLine.trim());
      }
      value = folded.join(' ').trim();
    }

    fields.set(key, stripYamlScalar(value));
  }

  const title = fields.get('title') || fields.get('name') || undefined;
  const description = fields.get('description') || undefined;
  return {
    title: title ? formatFallbackTitle(title) : undefined,
    description,
    bodyStartIndex: endIndex + '\n---\n'.length,
  };
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
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
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
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
