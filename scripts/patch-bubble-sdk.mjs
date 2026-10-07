// Aegis host compatibility for the pinned Bubble SDK. Re-run on install/build;
// fail on upstream drift rather than silently shipping an unpatched runtime.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function patchBubbleSdk(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '0.0.59') throw new Error(`Review Bubble host patch for SDK ${pkg.version}`);
  const jsPath = path.join(root, 'dist/sdk/index.js');
  const typesPath = path.join(root, 'dist/sdk/index.d.ts');
  let js = await readFile(jsPath, 'utf8');
  let types = await readFile(typesPath, 'utf8');
  const replace = (source, before, after) => {
    if (source.includes(after)) return source;
    if (source.split(before).length !== 2) throw new Error('Bubble SDK host patch no longer matches upstream');
    return source.replace(before, after);
  };
  // Steps whose output a later step rewrites are skipped once that later form is present.
  const hostToolsGated = js.includes('return tool.requiresApproval ? gateMcpTools([hosted], approvalController)[0] : hosted;');
  if (!js.includes('    hostTools = new Map();')) js = replace(js, '    projectTrustAsked = new Set();', `    // Aegis: serialize trust per folder; cancellation never consumes future prompts.
    projectTrustPending = new Map();
    hostTools = new Map();
    registerHostTool(tool) {
        if (!tool.readOnly || tool.effect !== "read") throw new Error("Host tools must be read-only");
        this.hostTools.set(tool.name, tool);
    }`);
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
  if (!hostToolsGated) js = replace(js,
    '            tools.push(...gateMcpTools(await awaitWithAbort(this.mcpToolsFor(cwd), abortSignal), approvalController));',
    `            const mcpTools = await awaitWithAbort(this.mcpToolsFor(cwd), abortSignal);
            tools.push(...gateMcpTools(mcpTools.filter(tool => !this.hostTools.has(tool.name)), approvalController));
            // Native host readers use the same read-only Plan gate as builtin
            // Read, while explicit deny rules remain authoritative.
            tools.push(...Array.from(this.hostTools.values(), tool => ({
                ...tool,
                execute: (args, ctx) => {
                    const rule = approvalController.checkRules({ tool: tool.name });
                    if (rule.decision === "deny") return Promise.resolve({ content: "Blocked by deny rule: " + rule.rule?.source, isError: true });
                    return tool.execute(args, ctx);
                },
            })));`);
  // Host actions (not readers) are gated like MCP tools, so they follow the
  // session's permission mode and stay out of Plan mode (readOnly false).
  js = replace(js,
    '        if (!tool.readOnly || tool.effect !== "read") throw new Error("Host tools must be read-only");',
    '        if ((!tool.readOnly || tool.effect !== "read") && tool.requiresApproval !== true) throw new Error("Host tools must be read-only or require approval");');
  if (!hostToolsGated) js = replace(js,
    `            tools.push(...Array.from(this.hostTools.values(), tool => ({
                ...tool,
                execute: (args, ctx) => {
                    const rule = approvalController.checkRules({ tool: tool.name });
                    if (rule.decision === "deny") return Promise.resolve({ content: "Blocked by deny rule: " + rule.rule?.source, isError: true });
                    return tool.execute(args, ctx);
                },
            })));`,
    `            tools.push(...Array.from(this.hostTools.values(), tool => {
                const hosted = {
                    ...tool,
                    execute: (args, ctx) => {
                        const rule = approvalController.checkRules({ tool: tool.name });
                        if (rule.decision === "deny") return Promise.resolve({ content: "Blocked by deny rule: " + rule.rule?.source, isError: true });
                        return tool.execute(args, ctx);
                    },
                };
                return tool.requiresApproval ? gateMcpTools([hosted], approvalController)[0] : hosted;
            }));`);
  types = replace(types, '    private readonly projectTrustAsked;', '    private readonly projectTrustPending;\n    private readonly hostTools;\n    registerHostTool(tool: import("../types.js").ToolRegistryEntry): void;');
  await writeFile(jsPath, js);
  await writeFile(typesPath, types);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchBubbleSdk(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@bubblebrain-ai/bubble'));
  console.log('Bubble SDK host patch applied (host tools and repeatable project trust)');
}
