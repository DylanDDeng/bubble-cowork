import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { grantArgs } from '@deepseek-ai/node-addon-system/landlock-run';

const marker = Symbol.for('aegis.deepseek.project-roots');

/** Runtime-only extension for the pinned SDK's single-root policy. */
export function installProjectRoots(raw = process.env.AEGIS_DSH_PROJECT_ROOTS) {
  if (!raw) return;
  const paths = JSON.parse(raw);
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Invalid Aegis project roots');
  }
  const roots = [...new Set(paths.map(path => {
    const root = realpathSync(path);
    if (!statSync(root).isDirectory()) throw new Error(`Project folder is not a directory: ${root}`);
    return root;
  }))];
  if (roots.length < 2) return;
  if (SandboxedFileSystem.prototype[marker]) throw new Error('Project roots already installed');
  const checkedTarget = SandboxedFileSystem.prototype.checkedTarget;
  const runnerArgv = LocalSandboxProvider.prototype.runnerArgv;
  const confine = LocalSandboxProvider.prototype.confine;
  if (typeof checkedTarget !== 'function' || typeof runnerArgv !== 'function' || typeof confine !== 'function') {
    throw new Error('DeepSeek SDK project-root extension is incompatible with this runtime');
  }
  SandboxedFileSystem.prototype[marker] = true;
  SandboxedFileSystem.prototype.checkedTarget = async function(target, explicitPolicy) {
    const policy = explicitPolicy ?? this.ctx.sandboxPolicy.resolve();
    try { return await checkedTarget.call(this, target, policy); }
    catch (error) {
      if (policy.mode !== 'workspace-write' || error.code !== 'FS_SANDBOX_DENIED') throw error;
      for (const root of roots) {
        try { return await checkedTarget.call(this, target, { ...policy, workspaceRoot: root }); }
        catch (next) { if (next.code !== 'FS_SANDBOX_DENIED') throw next; }
      }
      throw error;
    }
  };
  LocalSandboxProvider.prototype.runnerArgv = function(runner, policy) {
    if (runner === 'windows-acl' && policy.mode === 'workspace-write') {
      return [process.execPath, fileURLToPath(new URL('./runtime-project-roots-windows.mjs', import.meta.url)),
        JSON.stringify([...new Set([policy.workspaceRoot, ...roots])])];
    }
    const argv = runnerArgv.call(this, runner, policy);
    if (policy.mode !== 'workspace-write') return argv;
    const extra = roots.filter(root => root !== policy.workspaceRoot);
    if (runner === 'bwrap') return [...argv, ...extra.flatMap(root => ['--bind', root, root])];
    if (runner === 'landlock') return [...argv, ...grantArgs({ readWrite: extra })];
    if (runner === 'seatbelt') {
      const index = argv.indexOf('-p') + 1;
      if (!index || typeof argv[index] !== 'string') throw new Error('Unknown Seatbelt profile shape');
      argv[index] += ` (allow file-write* ${extra.map(root => `(subpath ${JSON.stringify(root)})`).join(' ')})`;
      return argv;
    }
    throw new Error(`DeepSeek multi-folder shell access is unavailable for sandbox runner ${runner}`);
  };
  LocalSandboxProvider.prototype.confine = function(argv, policy) {
    const result = confine.call(this, argv, policy);
    if (policy.mode !== 'workspace-write' || this.runnerCommand === undefined) return result;
    // The native custom runner contract uses the same bwrap mount arguments.
    const separator = result.argv.length - argv.length - 1;
    if (result.argv[separator] !== '--') throw new Error('Unknown custom sandbox runner shape');
    result.argv.splice(separator, 0, ...roots.flatMap(root => ['--bind', root, root]));
    return result;
  };
}
