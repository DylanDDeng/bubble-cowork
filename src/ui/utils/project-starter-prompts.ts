import type { GitChangeEntry, ProjectTreeNode } from '../../shared/types';

export const DEFAULT_PROJECT_STARTER_PROMPTS = [
  'Explain how this project is structured and where to start',
  'Find and fix a bug in the current code',
  'Add tests for the most important module',
  'Review my recent changes and suggest improvements',
];

type ProjectStarterContext = {
  tree?: ProjectTreeNode | null;
  gitChanges?: GitChangeEntry[];
};

function collectProjectPaths(tree: ProjectTreeNode | null | undefined): string[] {
  if (!tree) return [];
  const paths: string[] = [];
  const visit = (node: ProjectTreeNode, parents: string[]) => {
    const segments = [...parents, node.name];
    if (node.kind === 'file') {
      paths.push(segments.join('/').toLowerCase());
      return;
    }
    node.children?.forEach((child) => visit(child, segments));
  };
  tree.children?.forEach((child) => visit(child, []));
  return paths;
}

function hasFile(paths: string[], name: string): boolean {
  const normalized = name.toLowerCase();
  return paths.some((path) => path === normalized || path.endsWith(`/${normalized}`));
}

function hasPathPart(paths: string[], pattern: RegExp): boolean {
  return paths.some((path) => pattern.test(path));
}

function detectProjectStack(paths: string[]): string | null {
  const hasElectron = hasPathPart(paths, /(^|\/)src\/electron\//) || hasFile(paths, 'electron-builder.json');
  const hasReact = hasPathPart(paths, /\.(tsx|jsx)$/) && (
    hasFile(paths, 'vite.config.ts') ||
    hasFile(paths, 'vite.config.js') ||
    hasPathPart(paths, /(^|\/)src\/ui\//)
  );
  if (hasElectron && hasReact) return 'Electron and React';
  if (hasElectron) return 'Electron';
  if (hasReact) return 'React';
  if (hasFile(paths, 'next.config.js') || hasFile(paths, 'next.config.mjs') || hasFile(paths, 'next.config.ts')) {
    return 'Next.js';
  }
  if (hasFile(paths, 'cargo.toml')) return 'Rust';
  if (hasFile(paths, 'pyproject.toml') || hasFile(paths, 'requirements.txt')) return 'Python';
  if (hasFile(paths, 'go.mod')) return 'Go';
  if (hasFile(paths, 'package.json')) return 'JavaScript and TypeScript';
  return null;
}

function detectTests(paths: string[]): boolean {
  return hasPathPart(
    paths,
    /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$/
  );
}

function detectProjectGuide(paths: string[]): string | null {
  const preferred = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'README'];
  return preferred.find((name) => hasFile(paths, name)) ?? null;
}

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

function changedArea(entries: GitChangeEntry[]): string | null {
  if (entries.length === 0) return null;
  const roots = entries
    .map((entry) => entry.filePath.replace(/\\/g, '/').split('/').filter(Boolean)[0])
    .filter(Boolean);
  if (roots.length === 0 || !roots.every((root) => root === roots[0])) return null;
  return roots[0];
}

function buildChangePrompt(entries: GitChangeEntry[]): string | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    return `Review the current changes in ${basename(entries[0].filePath)} and identify likely regressions`;
  }
  const area = changedArea(entries);
  if (area) {
    return `Review the current changes in ${area} and identify likely regressions`;
  }
  return `Review the current changes across ${entries.length} files and identify likely regressions`;
}

export function deriveProjectStarterPrompts({
  tree,
  gitChanges = [],
}: ProjectStarterContext): string[] {
  const paths = collectProjectPaths(tree);
  if (paths.length === 0 && gitChanges.length === 0) {
    return DEFAULT_PROJECT_STARTER_PROMPTS;
  }

  const stack = detectProjectStack(paths);
  const hasTests = detectTests(paths);
  const guide = detectProjectGuide(paths);
  const projectKind = stack ? `${stack} project` : 'project';
  const changePrompt = buildChangePrompt(gitChanges);

  return [
    `Explain the ${projectKind} architecture and identify the best place to start`,
    changePrompt || (hasTests
      ? 'Run the existing test suite and fix the first meaningful failure'
      : 'Identify the highest-risk implementation area and explain why'),
    hasTests
      ? 'Find the most important untested workflow and add coverage'
      : `Add tests for the most important ${stack ? `${stack} ` : ''}workflow`,
    guide
      ? `Compare the implementation with ${guide} and flag the most important gap`
      : 'Find one high-impact improvement that fits the current project structure',
  ];
}
