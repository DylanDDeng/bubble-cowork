import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`));
    });
  });
}

async function main() {
  console.log('[dev:electron] Ensuring native dependencies match the current Electron runtime...');
  await run('./node_modules/.bin/electron-builder', ['install-app-deps']);
}

main().catch((error) => {
  console.error('[dev:electron] Failed to prepare native dependencies.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
