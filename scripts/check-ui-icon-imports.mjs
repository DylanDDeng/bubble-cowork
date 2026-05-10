import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const uiRoot = path.join(root, 'src/ui');
const allowedIconGateway = path.join(root, 'src/ui/components/icons.ts');
const blockedSources = new Set(['lucide-react', '@tabler/icons-react']);
const sourceExtensions = new Set(['.ts', '.tsx']);
const violations = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!sourceExtensions.has(path.extname(fullPath))) {
      continue;
    }

    if (fullPath === allowedIconGateway) {
      continue;
    }

    const source = readFileSync(fullPath, 'utf8');
    const importPattern = /from\s+['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      if (blockedSources.has(match[1])) {
        violations.push(`${path.relative(root, fullPath)} imports ${match[1]}`);
      }
    }
  }
}

walk(uiRoot);

if (violations.length > 0) {
  console.error('UI components must import icons from src/ui/components/icons.ts.');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('UI icon imports are routed through src/ui/components/icons.ts.');
