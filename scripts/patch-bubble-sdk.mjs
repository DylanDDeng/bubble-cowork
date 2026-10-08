// Aegis host compatibility for the pinned Bubble SDK. Re-run on install/build;
// fail on upstream drift rather than silently shipping an unpatched runtime.
// Host tools are upstream since 0.0.60 (turn-scoped `hostTools` on runTurn).
// Patched here: repeatable, serialized project trust; explicit deny rules for
// read-only host tools; and a host tool shadowing a same-named MCP tool
// instead of failing the turn.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function patchBubbleSdk(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '0.0.60') throw new Error(`Review Bubble host patch for SDK ${pkg.version}`);
  const jsPath = path.join(root, 'dist/sdk/index.js');
  const typesPath = path.join(root, 'dist/sdk/index.d.ts');
  let js = await readFile(jsPath, 'utf8');
  let types = await readFile(typesPath, 'utf8');
  const replace = (source, before, after) => {
    if (source.includes(after)) return source;
    if (source.split(before).length !== 2) throw new Error('Bubble SDK host patch no longer matches upstream');
    return source.replace(before, after);
  };
  js = replace(js, '    projectTrustAsked = new Set();', `    // Aegis: serialize trust per folder; cancellation never consumes future prompts.
    projectTrustPending = new Map();`);
  js = replace(js,
    'import { isRepoConfigTrusted, mergedRepoCapabilities, readRepoSettings, trustRepoConfig, }',
    'import { isRepoConfigTrusted, mergedRepoCapabilities, readRepoSettings, trustRepoConfig, repoConfigFingerprint, }');
  const begin = '    async resolveProjectTrust(cwd, options, signal) {';
  const end = '    /** Configured providers + default model, for a host\'s model picker. */';
  const start = js.indexOf(begin), finish = js.indexOf(end, start);
  if (start < 0 || finish < 0) throw new Error('Bubble trust seam missing');
  const original = js.slice(start, finish);
  if (!original.includes('projectTrustAsked') && !original.includes('projectTrustPending')) throw new Error('Bubble trust seam changed');
  js = js.slice(0, start) + `    async resolveProjectTrust(cwd, options, signal) {
        const previous = this.projectTrustPending.get(cwd) ?? Promise.resolve();
        const operation = previous.catch(() => undefined).then(async () => {
            throwAbortSignal(signal);
            // Read again after the previous question settles. Trust binds to the
            // exact displayed content, including changes made during a prompt.
            const raw = readRepoSettings(cwd);
            this.projectConfigFingerprints ??= new Map();
            const fingerprint = repoConfigFingerprint(cwd, raw);
            // Invalidate even when the changed file removes all capabilities,
            // or another SDK instance already trusted the replacement contents.
            if (this.projectConfigFingerprints.get(cwd) !== fingerprint) {
                const manager = this.mcpManagersByCwd.get(cwd);
                this.mcpManagersByCwd.delete(cwd);
                this.mcpToolsByCwd.delete(cwd);
                await (await manager?.catch(() => null))?.shutdown().catch(() => undefined);
                this.projectConfigFingerprints.set(cwd, fingerprint);
            }
            throwAbortSignal(signal);
            if (isRepoConfigTrusted(cwd, raw) || !options.onProjectTrust) return;
            const trusted = await awaitWithAbort(options.onProjectTrust({ cwd, pending: mergedRepoCapabilities(raw) }), signal);
            throwAbortSignal(signal);
            if (trusted) {
                trustRepoConfig(cwd, raw);
                const manager = this.mcpManagersByCwd.get(cwd);
                this.mcpManagersByCwd.delete(cwd);
                this.mcpToolsByCwd.delete(cwd);
                await (await manager?.catch(() => null))?.shutdown().catch(() => undefined);
            }
        });
        this.projectTrustPending.set(cwd, operation);
        const clean = () => {
            if (this.projectTrustPending.get(cwd) === operation) this.projectTrustPending.delete(cwd);
        };
        operation.then(clean, clean);
        // Cancel a queued caller promptly, while retaining its queue slot until
        // earlier work settles so another caller cannot overtake the prompt.
        await awaitWithAbort(operation, signal);
    }
` + js.slice(finish);
  js = replace(js,
    `            tools.push(...gateMcpTools(await awaitWithAbort(this.mcpToolsFor(cwd), abortSignal), approvalController));
            const hostTools = options.hostTools ?? [];`,
    `            const hostTools = options.hostTools ?? [];
            // Aegis: a host tool shadows a same-named MCP tool instead of failing the turn.
            const hostToolNames = new Set(hostTools.map(tool => tool.name));
            tools.push(...gateMcpTools((await awaitWithAbort(this.mcpToolsFor(cwd), abortSignal)).filter(tool => !hostToolNames.has(tool.name)), approvalController));`);
  js = replace(js,
    '                tools.push(...(tool.readOnly ? [guarded] : gateMcpTools([guarded], approvalController)));',
    `                // Aegis: read-only host tools skip the approval prompt, like builtin
                // Read in Plan mode, but explicit deny rules still bind them.
                const ruleChecked = {
                    ...guarded,
                    execute: (args, ctx) => {
                        const rule = approvalController.checkRules({ tool: tool.name });
                        if (rule.decision === "deny") return Promise.resolve({ content: "Blocked by deny rule: " + rule.rule?.source, isError: true });
                        return guarded.execute(args, ctx);
                    },
                };
                tools.push(...(tool.readOnly ? [ruleChecked] : gateMcpTools([guarded], approvalController)));`);
  types = replace(types, '    private readonly projectTrustAsked;', '    private readonly projectTrustPending;');
  await writeFile(jsPath, js);
  await writeFile(typesPath, types);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchBubbleSdk(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@bubblebrain-ai/bubble'));
  console.log('Bubble SDK host patch applied (project trust, host tool deny rules and MCP shadowing)');
}
