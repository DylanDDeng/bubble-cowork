// electron-builder entry point: the static settings live in
// electron-builder.json; this adds exclusions computed from package-lock.json.
// Build with `electron-builder --config electron-builder.config.cjs`
// (`npm run build:electron`); electron-builder would otherwise pick the JSON.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { unusedLauncherPackageNames } = require('./scripts/deepseek-sdk-closure.cjs');

// Parse the JSON with the same json5 reader electron-builder uses for it.
const json5 = createRequire(require.resolve('app-builder-lib/package.json'))('json5');
const config = json5.parse(fs.readFileSync(path.join(__dirname, 'electron-builder.json'), 'utf8'));

// The dsh CLI graph that @deepseek-ai/dsh-sdk-client depends on is never
// loaded (see scripts/deepseek-sdk-closure.cjs). Exclude, wherever
// electron-builder places them, the packages no other dependency uses.
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8')).packages;
const rootDependencies = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).dependencies;

config.files = [
  ...config.files,
  ...unusedLauncherPackageNames(lock, rootDependencies).flatMap((name) => [
    `!node_modules/${name}`,
    `!node_modules/${name}/**/*`,
    `!node_modules/**/node_modules/${name}`,
    `!node_modules/**/node_modules/${name}/**/*`,
  ]),
];

module.exports = config;
