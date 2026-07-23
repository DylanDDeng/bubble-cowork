import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees';
import type { CSSProperties } from 'react';

// Built-in file icons and filename rules come from @pierre/trees (Apache-2.0).
const iconResolver = createFileTreeIconResolver({ set: 'complete', colored: true });
const builtInSpriteSheet = getBuiltInSpriteSheet('complete');

type BuiltInSymbol = {
  dataUrl: string;
  viewBox: string;
};

type FileIconVisual = BuiltInSymbol & {
  color: string;
  token: string;
};

const ICON_COLOR_BY_FAMILY = {
  gray: 'color-mix(in srgb, var(--text-secondary) 82%, var(--text-primary))',
  red: 'color-mix(in srgb, var(--error) 88%, var(--text-primary))',
  vermilion: 'color-mix(in srgb, var(--warning) 78%, var(--error))',
  orange: 'var(--warning)',
  yellow: 'color-mix(in srgb, var(--warning) 72%, #f5c84b)',
  green: 'var(--success)',
  teal: 'color-mix(in srgb, var(--success) 58%, var(--accent))',
  cyan: 'color-mix(in srgb, var(--accent) 62%, #38bdf8)',
  blue: 'color-mix(in srgb, var(--accent) 72%, #3b82f6)',
  indigo: 'var(--accent)',
  purple: 'color-mix(in srgb, var(--accent) 82%, #c026d3)',
  pink: 'color-mix(in srgb, var(--accent) 46%, #ec4899)',
  mauve: 'color-mix(in srgb, var(--text-secondary) 76%, var(--accent))',
} as const;

type IconColorFamily = keyof typeof ICON_COLOR_BY_FAMILY;

const ICON_COLOR_FAMILY_BY_TOKEN: Record<string, IconColorFamily> = {
  astro: 'purple',
  babel: 'yellow',
  bash: 'green',
  biome: 'blue',
  bootstrap: 'indigo',
  browserslist: 'yellow',
  bun: 'mauve',
  c: 'blue',
  claude: 'orange',
  cpp: 'blue',
  css: 'indigo',
  database: 'purple',
  default: 'gray',
  docker: 'blue',
  eslint: 'indigo',
  font: 'pink',
  git: 'vermilion',
  go: 'cyan',
  graphql: 'pink',
  html: 'orange',
  image: 'pink',
  javascript: 'yellow',
  json: 'orange',
  markdown: 'green',
  mcp: 'teal',
  nextjs: 'gray',
  npm: 'red',
  oxc: 'cyan',
  postcss: 'red',
  prettier: 'teal',
  python: 'blue',
  react: 'cyan',
  ruby: 'red',
  rust: 'orange',
  sass: 'pink',
  stylelint: 'indigo',
  svelte: 'red',
  svg: 'orange',
  svgo: 'green',
  swift: 'orange',
  table: 'teal',
  tailwind: 'cyan',
  terraform: 'indigo',
  text: 'gray',
  typescript: 'blue',
  vite: 'purple',
  vscode: 'blue',
  vue: 'green',
  wasm: 'indigo',
  webpack: 'blue',
  yml: 'red',
  zig: 'orange',
  zip: 'orange',
};

function buildSymbolRegistry(spriteSheet: string): Map<string, BuiltInSymbol> {
  const symbols = new Map<string, BuiltInSymbol>();
  const symbolPattern = /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g;

  for (const match of spriteSheet.matchAll(symbolPattern)) {
    const [, id, viewBox, contents] = match;
    const standaloneSvg = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
      contents.replaceAll('currentColor', '#000').replaceAll('currentcolor', '#000'),
      '</svg>',
    ].join('');

    symbols.set(id, {
      dataUrl: `data:image/svg+xml,${encodeURIComponent(standaloneSvg)}`,
      viewBox,
    });
  }

  return symbols;
}

const builtInSymbols = buildSymbolRegistry(builtInSpriteSheet);
const fallbackSymbol = builtInSymbols.get('file-tree-builtin-default');

export function getFileTypeIconVisual(name: string): FileIconVisual | null {
  const resolved = iconResolver.resolveIcon('file-tree-icon-file', name);
  const symbol = builtInSymbols.get(resolved.name) ?? fallbackSymbol;
  if (!symbol) return null;

  const token = resolved.token ?? 'default';
  const colorFamily = ICON_COLOR_FAMILY_BY_TOKEN[token] ?? 'gray';
  return {
    ...symbol,
    color: ICON_COLOR_BY_FAMILY[colorFamily],
    token,
  };
}

/**
 * Retained for non-React consumers. Prefer getFileTypeIconVisual() when the
 * icon needs to follow the active theme.
 */
export function getFileTypeIconUrl(name: string): string {
  return getFileTypeIconVisual(name)?.dataUrl ?? '';
}

export function FileTypeIcon({
  name,
  className = 'h-4 w-4',
  fallbackClassName = 'h-3.5 w-3.5 text-[var(--text-secondary)]',
  useCurrentColor = false,
}: {
  name: string;
  className?: string;
  fallbackClassName?: string;
  useCurrentColor?: boolean;
}) {
  const visual = getFileTypeIconVisual(name);

  if (!visual) {
    return <span aria-hidden="true" className={fallbackClassName} />;
  }

  const style: CSSProperties = {
    backgroundColor: 'currentColor',
    color: useCurrentColor ? 'currentColor' : visual.color,
    WebkitMaskImage: `url("${visual.dataUrl}")`,
    WebkitMaskPosition: 'center',
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskSize: 'contain',
    maskImage: `url("${visual.dataUrl}")`,
    maskPosition: 'center',
    maskRepeat: 'no-repeat',
    maskSize: 'contain',
  };

  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 ${className}`}
      data-file-icon-token={visual.token}
      style={style}
    />
  );
}
