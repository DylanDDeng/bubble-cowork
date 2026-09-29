import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A local document is a browser target, not a project-tree read. Absolute
// artifact paths may legitimately live in another checkout or a temp folder.
// Keep Chromium's normal file-origin rules; never expose a parent directory
// through an HTTP server merely to make an external artifact previewable.
export async function getHtmlPreviewUrl(
  cwd: string,
  filePath: string,
  serveProjectFile?: (root: string, target: string) => Promise<{ ok: true; url: string } | { ok: false; message: string }>,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!filePath?.trim()) return { ok: false, message: 'Missing preview file path' };
  let target = filePath;
  try {
    if (/^file:/i.test(target)) {
      const url = new URL(target);
      if (!isLocalFileUrl(url.href)) return { ok: false, message: 'Preview requires a local file' };
      target = fileURLToPath(url);
    } else if (target.startsWith('~/') || target.startsWith('~\\')) {
      target = join(homedir(), target.slice(2));
    }
    if (!isAbsolute(target) && !cwd) return { ok: false, message: 'Relative preview paths require a working directory' };
    target = resolve(cwd || '.', target);
    if (!/\.html?$/i.test(extname(target))) {
      return { ok: false, message: 'Only HTML files can be previewed in the browser' };
    }
    if (!(await fs.stat(target)).isFile()) return { ok: false, message: 'Preview target is not a file' };
    // Preserve the existing project HTTP preview for ES modules / fetch.
    // Files elsewhere use native file navigation, without widening that
    // server's allowed root or changing project read/write permissions.
    if (serveProjectFile && cwd) {
      const root = await fs.realpath(cwd).catch(() => null);
      const realTarget = await fs.realpath(target);
      if (root) {
        const rel = relative(root, realTarget);
        if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
          return serveProjectFile(root, realTarget);
        }
      }
    }
    // Preserve symlink paths so neighboring resources resolve at the path the
    // user opened, as they do in a regular browser.
    return { ok: true, url: pathToFileURL(target).href };
  } catch (error) {
    return { ok: false, message: `Could not open preview file: ${String(error)}` };
  }
}

export function isLocalFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const filePath = fileURLToPath(url);
    return url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')
      && !filePath.startsWith('\\\\') && !filePath.includes('\0');
  } catch {
    return false;
  }
}
