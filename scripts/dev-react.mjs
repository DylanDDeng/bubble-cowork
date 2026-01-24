import { spawn } from 'node:child_process';
import path from 'node:path';

const DEV_SERVER_PORT = process.env.PORT || '10087';
const viteBin = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

function spawnVite(args, extraEnv = {}) {
  const child = spawn(process.execPath, [viteBin, ...args], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });

  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  return child;
}

function startBuildWatch() {
  console.warn(
    `\n[dev:react] Falling back to \`vite build --watch\` (dev server port bind blocked).`
  );
  console.warn('[dev:react] Electron will load `dist-react/index.html` instead of the dev server.\n');

  const child = spawnVite(['build', '--watch', '--mode', 'development'], {
    VITE_BUILD_WATCH: '1',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

let sawListenPermissionError = false;

const devServer = spawnVite([], { PORT: DEV_SERVER_PORT });

devServer.stderr.on('data', (chunk) => {
  const text = String(chunk);
  if (text.includes('listen EPERM') || text.includes('listen EACCES')) {
    sawListenPermissionError = true;
  }
});

devServer.on('exit', (code) => {
  if (code === 0) {
    process.exit(0);
  }

  if (sawListenPermissionError) {
    startBuildWatch();
    return;
  }

  process.exit(code ?? 1);
});
