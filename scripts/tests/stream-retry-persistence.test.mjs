import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
execFileSync(require('electron'), [fileURLToPath(new URL('./stream-retry-persistence.test.cjs', import.meta.url))], {
  env, stdio: 'inherit', timeout: 30000,
});
