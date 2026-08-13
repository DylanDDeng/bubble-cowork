import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveGrokSessionRelativeFile } from '../../src/electron/libs/grok-session-files';
import { findGeneratedMediaForPath } from '../../src/ui/utils/generated-media';

function testSessionRelativeResolve() {
  const home = join(tmpdir(), `aegis-grok-sessions-${Date.now()}`);
  const cwd = '/Users/test/coworker';
  const sessionDir = join(home, '.grok', 'sessions', encodeURIComponent(cwd), 'session-abc');
  mkdirSync(join(sessionDir, 'images'), { recursive: true });
  const imagePath = join(sessionDir, 'images', '1.jpg');
  writeFileSync(imagePath, 'fake-image');

  try {
    assert.equal(
      resolveGrokSessionRelativeFile(cwd, 'images/1.jpg', home),
      imagePath
    );
    assert.equal(
      resolveGrokSessionRelativeFile(cwd, 'images/missing.jpg', home),
      null
    );
    assert.equal(
      resolveGrokSessionRelativeFile(cwd, '../1.jpg', home),
      null
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function testTranscriptMatch() {
  const hit = findGeneratedMediaForPath('images/1.jpg', [
    { path: '/tmp/.grok/sessions/x/images/1.jpg', kind: 'image' },
  ]);
  assert.equal(hit?.path, '/tmp/.grok/sessions/x/images/1.jpg');
}

testSessionRelativeResolve();
testTranscriptMatch();
console.log('grok-session-files tests passed');
