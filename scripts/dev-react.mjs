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

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => resolve({ ok: false, stdout: '', stderr: '' }));
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function killPortOwner(port) {
  const lookup = await runCommand('lsof', ['-ti', `tcp:${port}`]);
  if (!lookup.ok) {
    return false;
  }

  const pids = lookup.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((pid) => pid !== String(process.pid));

  if (pids.length === 0) {
    return false;
  }

  const killResult = await runCommand('kill', ['-9', ...pids]);
  if (!killResult.ok) {
    return false;
  }

  console.warn(`[dev:react] Freed occupied port ${port} by terminating PID(s): ${pids.join(', ')}`);
  return true;
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
let sawAddressInUseError = false;
let retriedAfterAddressInUse = false;

function runDevServer() {
  sawListenPermissionError = false;
  sawAddressInUseError = false;

  const devServer = spawnVite([], { PORT: DEV_SERVER_PORT });

  devServer.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (text.includes('listen EPERM') || text.includes('listen EACCES')) {
      sawListenPermissionError = true;
    }
    if (text.includes('Port') && text.includes('is already in use')) {
      sawAddressInUseError = true;
    }
  });

  devServer.on('exit', async (code) => {
    if (code === 0) {
      process.exit(0);
    }

    if (sawListenPermissionError) {
      startBuildWatch();
      return;
    }

    if (sawAddressInUseError && !retriedAfterAddressInUse) {
      retriedAfterAddressInUse = true;
      const cleared = await killPortOwner(DEV_SERVER_PORT);
      if (cleared) {
        runDevServer();
        return;
      }
    }

    process.exit(code ?? 1);
  });
}

runDevServer();
