import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function createProfile(root: string): string {
  mkdirSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), {
    recursive: true,
  });
  writeFileSync(path.join(root, 'runtime-bin.mjs'), '#!/usr/bin/env node\n');
  return root;
}

const testRoot = mkdtempSync(path.join(tmpdir(), 'aegis-dsh-profile-resolution-'));
const testHome = path.join(testRoot, 'home');
const resourcesPath = path.join(testRoot, 'Aegis.app', 'Contents', 'Resources');
const bundledProfile = createProfile(path.join(resourcesPath, 'deepseek-harness'));
const overrideProfile = createProfile(path.join(testRoot, 'override-profile'));
mkdirSync(testHome, { recursive: true });

const originalHome = process.env.HOME;
const originalOverride = process.env.AEGIS_DSH_PROFILE_DIR;
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

try {
  process.env.HOME = testHome;
  delete process.env.AEGIS_DSH_PROFILE_DIR;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });

  delete require.cache[require.resolve('../../src/electron/libs/deepseek-cli.ts')];
  const cli = require('../../src/electron/libs/deepseek-cli.ts') as {
    resolveDeepseekProfileDir: () => string | null;
    resolveDeepseekSessionRoot: (profileDir: string) => string;
  };

  assert.equal(
    cli.resolveDeepseekProfileDir(),
    bundledProfile,
    'a packaged app must discover the profile copied beside app.asar'
  );
  assert.equal(
    cli.resolveDeepseekSessionRoot(bundledProfile),
    path.join(testHome, '.aegis', 'deepseek-sessions'),
    'bundled profiles must persist sessions outside read-only app resources'
  );

  process.env.AEGIS_DSH_PROFILE_DIR = overrideProfile;
  assert.equal(
    cli.resolveDeepseekProfileDir(),
    overrideProfile,
    'an explicit profile override must win over the bundled runtime'
  );
  assert.equal(
    cli.resolveDeepseekSessionRoot(overrideProfile),
    path.join(overrideProfile, '.sessions'),
    'explicit profiles retain their colocated session store for compatibility'
  );

  console.log('deepseek-profile-resolution tests passed');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOverride === undefined) delete process.env.AEGIS_DSH_PROFILE_DIR;
  else process.env.AEGIS_DSH_PROFILE_DIR = originalOverride;
  if (resourcesDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
  } else {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }
  rmSync(testRoot, { recursive: true, force: true });
}
