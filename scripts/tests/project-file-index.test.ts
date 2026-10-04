import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findProjectFileByName } from '../../src/electron/libs/project-file-index';

async function main() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aegis-file-index-')));
  try {
    for (const dir of ['attachments', 'notes/deep/deeper', '.obsidian', 'node_modules/pkg']) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ['note.md', 'attachments/Clip.mp4', 'notes/deep/deeper/clip.mp4', '.obsidian/hidden.mp4', 'node_modules/pkg/dep.mp4', 'notes/100%.png']) {
      await writeFile(path.join(root, file), '');
    }
    assert.equal(await findProjectFileByName(root, 'clip.mp4'), path.join(root, 'attachments/Clip.mp4'), 'shallowest match wins, case-insensitively');
    assert.equal(await findProjectFileByName(root, '100%.png'), path.join(root, 'notes/100%.png'));
    assert.equal(await findProjectFileByName(root, 'hidden.mp4'), null, 'dot folders are skipped');
    assert.equal(await findProjectFileByName(root, 'dep.mp4'), null, 'node_modules is skipped');
    assert.equal(await findProjectFileByName(root, 'deep/deeper/clip.mp4'), null, 'only bare names are looked up');
    assert.equal(await findProjectFileByName(root, 'missing.mp4'), null);
    assert.equal(await findProjectFileByName('', 'clip.mp4'), null);
    console.log('project-file-index: vault-wide name lookup passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
