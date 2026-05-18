import { constants, existsSync } from 'fs';
import { access, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { parseUnifiedDiff } from '../../../../shared/unified-diff';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asString, resolveInsideCwd } from './common';
import { countDiffChanges, createToolUnifiedDiff } from './diff-utils';
import { withFileMutationQueue } from './file-mutation-queue';

interface PatchFile {
  path: string;
  hunksText: string;
}

export function createPatchTool(cwd: string, approval?: BuiltinApprovalController): BuiltinToolRegistryEntry {
  return {
    name: 'patch',
    description: 'Apply a unified diff to one or more UTF-8 project files. Use this for larger edits when exact string replacement is awkward.',
    parameters: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff content with ---/+++ file headers and @@ hunks.' },
      },
      required: ['diff'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const diff = asString(args.diff);
      if (!diff.trim()) return { content: 'Error: diff is required', isError: true, status: 'command_error' };
      const files = parsePatchFiles(diff);
      if (files.length === 0) {
        return { content: 'Error: no unified-diff file hunks were found', isError: true, status: 'command_error' };
      }

      const outputs: string[] = [];
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const patchFile of files) {
        const file = resolveInsideCwd(cwd, patchFile.path);
        if (!file.ok) return { content: `Error: ${file.error}`, isError: true, status: 'command_error' };

        const result = await withFileMutationQueue(file.path, async () => {
          const original = await readPatchTarget(file.path);
          if (original === null) {
            return { content: `Error: Cannot read/write file: ${file.rel}`, isError: true, status: 'command_error' as const };
          }

          let next: string;
          try {
            next = applyPatchToContent(original, patchFile.hunksText);
          } catch (error) {
            return {
              content: `Error: ${error instanceof Error ? error.message : String(error)} in ${file.rel}`,
              isError: true,
              status: 'command_error' as const,
            };
          }
          if (next === original) {
            return { content: `No changes needed for ${file.rel}.`, status: 'success' as const, metadata: { kind: 'edit' as const, path: file.path } };
          }

          const generatedDiff = createToolUnifiedDiff(file.rel, original, next);
          const changes = countDiffChanges(generatedDiff);
          const decision = await approval?.requestFileChange({
            id: ctx.toolCall.id,
            toolName: 'patch',
            title: 'Apply patch',
            question: `Allow Aegis Built-in Agent to patch ${file.rel}?`,
            filePath: file.path,
            summary: [
              `Patch ${file.rel}`,
              `${changes.addedLines} line(s) added, ${changes.removedLines} removed`,
            ],
          });
          if (decision && decision.behavior !== 'allow') {
            return { content: decision.message || 'Patch was denied by the user.', isError: true, status: 'blocked' as const };
          }

          const latest = await readPatchTarget(file.path);
          if (latest !== original) {
            return {
              content: `Error: Cannot safely patch ${file.rel} because it changed while approval was pending. Re-read the file and retry against the latest content.`,
              isError: true,
              status: 'blocked' as const,
              metadata: { kind: 'security' as const, path: file.path, reason: 'changed' },
            };
          }
          await mkdir(dirname(file.path), { recursive: true });
          await writeFile(file.path, next, 'utf-8');
          totalAdded += changes.addedLines;
          totalRemoved += changes.removedLines;
          return {
            content: [
              `Patched ${file.rel}.`,
              generatedDiff ? `\nDiff:\n${generatedDiff}` : '',
            ].filter(Boolean).join('\n'),
            status: 'success' as const,
            metadata: {
              kind: 'edit' as const,
              path: file.path,
              diff: generatedDiff,
              addedLines: changes.addedLines,
              removedLines: changes.removedLines,
            },
          };
        });

        if (result.isError) return result;
        outputs.push(result.content);
      }

      return {
        content: outputs.join('\n\n'),
        status: 'success',
        metadata: { kind: 'edit', matches: files.length, addedLines: totalAdded, removedLines: totalRemoved },
      };
    },
  };
}

function parsePatchFiles(diff: string): PatchFile[] {
  const lines = diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const files: PatchFile[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('--- ')) continue;
    const oldPath = cleanPatchPath(lines[index].slice(4).trim());
    const nextLine = lines[index + 1] || '';
    if (!nextLine.startsWith('+++ ')) continue;
    const newPath = cleanPatchPath(nextLine.slice(4).trim());
    const path = newPath !== '/dev/null' ? newPath : oldPath;
    if (!path || path === '/dev/null') continue;

    const hunkLines: string[] = [];
    index += 2;
    while (index < lines.length) {
      if (lines[index].startsWith('--- ') && (lines[index + 1] || '').startsWith('+++ ')) {
        index -= 1;
        break;
      }
      hunkLines.push(lines[index]);
      index += 1;
    }
    files.push({ path, hunksText: hunkLines.join('\n') });
  }
  return files;
}

function cleanPatchPath(value: string): string {
  const path = value.split('\t')[0].split(' ')[0].trim();
  if (path === '/dev/null') return path;
  return path.replace(/^a\//, '').replace(/^b\//, '');
}

async function readPatchTarget(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return '';
  try {
    await access(filePath, constants.R_OK | constants.W_OK);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) return null;
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function applyPatchToContent(content: string, hunksText: string): string {
  const hunks = parseUnifiedDiff(hunksText);
  if (hunks.length === 0) throw new Error('patch does not contain any @@ hunks');

  const hadFinalNewline = content.endsWith('\n');
  const lines = content ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') : [];
  if (hadFinalNewline && lines[lines.length - 1] === '') lines.pop();
  let offset = 0;

  for (const hunk of hunks) {
    let index = Math.max(0, hunk.oldStart - 1 + offset);
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        assertLine(lines, index, line.text);
        index += 1;
        continue;
      }
      if (line.type === 'deletion') {
        assertLine(lines, index, line.text);
        lines.splice(index, 1);
        offset -= 1;
        continue;
      }
      lines.splice(index, 0, line.text);
      index += 1;
      offset += 1;
    }
  }

  const next = lines.join('\n');
  return hadFinalNewline || lines.length > 0 ? `${next}\n` : next;
}

function assertLine(lines: string[], index: number, expected: string): void {
  const actual = lines[index];
  if (actual !== expected) {
    throw new Error(`patch context mismatch at line ${index + 1}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual ?? '')}`);
  }
}
