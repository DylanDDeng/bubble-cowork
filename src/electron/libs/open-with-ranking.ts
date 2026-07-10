import { basename } from 'path';

/**
 * Rank "Open with" candidates for a file without hardcoding app names.
 *
 * For text-like files we query Launch Services twice: once for the actual
 * file, once for a plain-text probe. The intersection separates real editors
 * from extension-collision handlers (Qt Linguist claims `.ts` because Qt
 * translation sources use that extension; video players claim `.mts`), which
 * would otherwise win the default slot for code files:
 *
 * - tier 1: claims the file AND opens plain text → editors, keep LS order
 *           (the user's real default editor stays first);
 * - tier 2: opens plain text only → generic editors;
 * - tier 3: claims the extension but cannot open plain text → collision
 *           suspects, sink to the bottom.
 *
 * With an empty `textApps` (binary files, probe unavailable) this degrades to
 * the original Launch-Services order.
 */
export function rankOpenWithAppPaths(params: {
  fileApps: string[];
  textApps: string[];
  limit: number;
}): string[] {
  const fileSet = new Set(params.fileApps);
  const textSet = new Set(params.textApps);

  const tier1 = params.fileApps.filter((path) => textSet.has(path));
  const tier2 = params.textApps.filter((path) => !fileSet.has(path));
  const tier3 = params.fileApps.filter((path) => !textSet.has(path));

  const result: string[] = [];
  const seenNames = new Set<string>();
  for (const appPath of [...tier1, ...tier2, ...tier3]) {
    if (!appPath || isJunkOpenWithPath(appPath)) continue;
    // One entry per app NAME: stale duplicate installs (migration leftovers,
    // bundled copies) otherwise repeat in the menu.
    const nameKey = openWithDisplayName(appPath).toLowerCase();
    if (!nameKey || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    result.push(appPath);
    if (result.length >= params.limit) break;
  }
  return result;
}

export function openWithDisplayName(appPath: string): string {
  const base = basename(appPath);
  return base.toLowerCase().endsWith('.app') ? base.slice(0, -'.app'.length) : base;
}

/**
 * Installs the user never launches deliberately: macOS-migration leftovers and
 * app bundles buried inside hidden directories (runtime caches and the like).
 */
function isJunkOpenWithPath(appPath: string): boolean {
  if (appPath.includes('/Previously Relocated Items/')) return true;
  return /\/\.[^/]+\//.test(appPath);
}

const OPEN_WITH_BINARY_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'icns', 'ico', 'bmp', 'tiff', 'tif',
  // audio / video
  'mp4', 'mov', 'mkv', 'avi', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'webm',
  // archives / images-of-disks
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg',
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers',
  // fonts / binaries
  'ttf', 'otf', 'woff', 'woff2', 'exe', 'dylib', 'so', 'node', 'wasm', 'sqlite', 'db',
]);

/** Text-like files get the plain-text editor probe; known binaries do not. */
export function isTextLikeForOpenWith(targetPath: string): boolean {
  const base = basename(targetPath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // extensionless (Makefile, LICENSE, dotfiles)
  const ext = base.slice(dot + 1).toLowerCase();
  return !OPEN_WITH_BINARY_EXTENSIONS.has(ext);
}
