import assert from 'node:assert/strict';
import { siteRootPathCandidates } from '../../src/shared/site-root-path';

const root = '/Users/me/site';

// A site-root path falls back to the static dirs used by Hugo / Astro / Vite, then the project root.
assert.deepEqual(siteRootPathCandidates(root, '/media/a.svg'), [
  '/media/a.svg',
  '/Users/me/site/static/media/a.svg',
  '/Users/me/site/public/media/a.svg',
  '/Users/me/site/media/a.svg',
]);
assert.deepEqual(siteRootPathCandidates(`${root}/`, '/media/a.svg')[1], '/Users/me/site/static/media/a.svg');

// Real in-project absolute paths, relative paths, UNC-like and drive paths are left alone.
assert.deepEqual(siteRootPathCandidates(root, '/Users/me/site/img/a.png'), ['/Users/me/site/img/a.png']);
assert.deepEqual(siteRootPathCandidates(root, 'img/a.png'), ['img/a.png']);
assert.deepEqual(siteRootPathCandidates(root, '//host/a.png'), ['//host/a.png']);
assert.deepEqual(siteRootPathCandidates('C:\\site', 'C:/site/a.png'), ['C:/site/a.png']);
assert.deepEqual(siteRootPathCandidates('C:\\site', '/media/a.png')[1], 'C:/site/static/media/a.png');

console.log('site-root-path tests passed');
