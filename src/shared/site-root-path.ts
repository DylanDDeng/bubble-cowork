// Static-site Markdown (Hugo, Astro, Vite, Next...) writes assets as site-root paths such as
// `/media/a.svg`, which live under `static/` or `public/` on disk rather than at the filesystem root.
const SITE_ROOT_DIRS = ['static', 'public', ''];

/**
 * Candidate filesystem paths for a Markdown asset path, most literal first. Only a POSIX-style
 * `/path` that is not already inside the project gets site-root fallbacks; every candidate must
 * still pass the caller's project containment check.
 */
export function siteRootPathCandidates(projectRoot: string, src: string): string[] {
  if (!src.startsWith('/') || src.startsWith('//')) return [src];
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root || src === root || src.startsWith(`${root}/`)) return [src];
  return [src, ...SITE_ROOT_DIRS.map(dir => `${root}${dir ? `/${dir}` : ''}${src}`)];
}
