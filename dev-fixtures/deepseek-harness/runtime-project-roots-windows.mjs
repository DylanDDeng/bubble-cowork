import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AclSandbox, AclWriteGrant, assertTempRootOutsideWorkspace, workspaceWriteSid, tempWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';

/** Use the native restricted token with revocable, per-invocation grants. */
export async function runWindowsProjectCommand(roots, command, args, api = { AclSandbox, AclWriteGrant }) {
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === 'string' && isAbsolute(root))) {
    throw new Error('Invalid project roots');
  }
  roots = [...new Set(roots.map(root => realpathSync(root)))];
  for (const root of roots) {
    if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    assertTempRootOutsideWorkspace(root, tmpdir());
  }
  const temp = mkdtempSync(join(tmpdir(), 'aegis-dsh-'));
  // A fresh capability prevents another session with the same primary cwd
  // from inheriting this session's additional-directory grants.
  const writeSid = workspaceWriteSid(temp);
  const privateSid = tempWriteSid(temp);
  const grants = [];
  const oldTemp = { TMP: process.env.TMP, TEMP: process.env.TEMP };
  let sandbox, initialized = false;
  try {
    const workspaceGrant = api.AclWriteGrant.create(writeSid); grants.push(workspaceGrant);
    for (const root of roots) workspaceGrant.add(root);
    const tempGrant = api.AclWriteGrant.create(privateSid); grants.push(tempGrant); tempGrant.add(temp);
    sandbox = new api.AclSandbox({ writableDirs: roots, tempDir: temp, mode: 'workspace-write',
      writeSid, tempWriteSid: privateSid, manageDacls: false });
    await sandbox.init(); initialized = true;
    // The SDK's native spawning seam reads the Win32 environment block.
    process.env.TMP = temp; process.env.TEMP = temp;
    return (await sandbox.spawn({command, args, stdio:'inherit'}).wait()).exitCode;
  } finally {
    for (const [name, value] of Object.entries(oldTemp)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const failures = [];
    if (initialized) try { sandbox.dispose(); } catch (error) { failures.push(error); }
    for (const grant of grants.reverse()) try { grant.dispose(); } catch (error) { failures.push(error); }
    try { rmSync(temp, {recursive:true, force:true}); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Windows sandbox grant cleanup failed');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || process.argv[3] !== '--' || !process.argv[4]) throw new Error('Invalid Windows sandbox invocation');
    process.exitCode = await runWindowsProjectCommand(JSON.parse(process.argv[2]), process.argv[4], process.argv.slice(5));
  } catch (error) {
    process.stderr.write(`windows-acl-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 127;
  }
}
