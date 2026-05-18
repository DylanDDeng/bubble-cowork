import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const electronArgs = args.length > 0 ? args : ['.'];

const child = spawn('./node_modules/.bin/electron', electronArgs, {
  stdio: 'inherit',
  env,
});

child.on('error', (error) => {
  console.error('[dev:electron] Failed to launch Electron.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (code === null) {
    console.error(`Electron exited with signal ${signal ?? 'unknown'}`);
    process.exit(1);
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}
