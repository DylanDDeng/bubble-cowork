import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exceljsRoot = path.join(projectRoot, 'node_modules', 'exceljs');
const archiverPackage = JSON.parse(
  await readFile(path.join(projectRoot, 'node_modules', 'archiver', 'package.json'), 'utf8')
);

if (Number.parseInt(archiverPackage.version, 10) < 8) {
  process.exit(0);
}

const writerFiles = [
  path.join(exceljsRoot, 'lib', 'stream', 'xlsx', 'workbook-writer.js'),
  path.join(exceljsRoot, 'dist', 'es5', 'stream', 'xlsx', 'workbook-writer.js'),
];

const oldImport = "const Archiver = require('archiver');";
const newImport = "const {ZipArchive} = require('archiver');";
const streamImport = "const {PassThrough} = require('node:stream');";
const oldFactory = "this.zip = Archiver('zip', this.zipOptions);";
const newFactory = 'this.zip = new ZipArchive(this.zipOptions);';
const oldAppend = /this\.zip\.append\(stream,\s*\{\s*name:\s*path\s*\}\);/m;
const newAppend =
  'const source = new PassThrough();\n    stream.pipe(source);\n    this.zip.append(source, {name: path});';

for (const writerFile of writerFiles) {
  let source = await readFile(writerFile, 'utf8');
  if (source.includes(oldImport)) {
    source = source.replace(oldImport, newImport);
  }
  if (source.includes(oldFactory)) {
    source = source.replace(oldFactory, newFactory);
  }
  if (!source.includes(streamImport)) {
    source = source.replace(newImport, `${newImport}\n${streamImport}`);
  }
  if (oldAppend.test(source)) {
    source = source.replace(oldAppend, newAppend);
  }
  if (
    !source.includes(newImport) ||
    !source.includes(streamImport) ||
    !source.includes(newFactory) ||
    !source.includes('this.zip.append(source, {name: path});')
  ) {
    throw new Error(`Unexpected ExcelJS workbook writer shape: ${writerFile}`);
  }
  await writeFile(writerFile, source);
}

console.log(`Patched ExcelJS streaming writer for archiver ${archiverPackage.version}`);
