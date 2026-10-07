/**
 * scripts/probe-workflow-planner-schema.ts — checks that the workflow Planner
 * exchange-format schema (src/workflow-engine/spec/planned-workflow.ts) is
 * accepted by real structured-output modes, and that what comes back
 * validates and converts.
 *
 * Usage:
 *   npx tsx scripts/probe-workflow-planner-schema.ts            # claude + codex
 *   npx tsx scripts/probe-workflow-planner-schema.ts claude     # one provider
 *   CLAUDE_PROBE_EXECUTABLE=$(which claude) npx tsx scripts/probe-workflow-planner-schema.ts claude
 *   CODEX_PROBE_EXECUTABLE=$(which codex) npx tsx scripts/probe-workflow-planner-schema.ts codex
 *     (npx prepends ancestor node_modules/.bin to PATH, which can shadow the real codex)
 *
 * Uses the machine's existing Claude / Codex logins and spends a small amount
 * of usage. Runs in a throwaway temp directory with no write access.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildPlannedWorkflowSchema, type PlannedWorkflow } from '../src/workflow-engine/spec/planned-workflow';
import { convertPlannedWorkflow } from '../src/workflow-engine/convert/from-planned';

const AGENTS = ['claude', 'codex', 'kimi', 'opencode'];
const schema = buildPlannedWorkflowSchema({ agentNames: AGENTS, modelIds: [] });
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

const USER_REQUEST =
  '实现登录功能，Codex 写代码，Claude 检查安全，另一个 Codex 检查边界情况，有问题修复后再审查。';

const PROMPT = `You are the workflow planner for a multi-agent coding app. Turn the user's request into a workflow in the required JSON format. Do not use any tools and do not read files.

Rules:
- Member "agent" must be one of: ${AGENTS.join(', ')}. Roles: implementer writes code; reviewer reviews; advisor investigates or answers.
- Steps are a flat list. Nesting is expressed with "parent" (the id of a parallel, repeat or reviewLoop step) and "order" within the parent. Fields that do not apply to a step's kind must be null.
- Prefer a single "reviewLoop" step for implement → check → parallel review → fix → re-review. Its "max" is the number of repair rounds. Check steps placed inside it use parent = the reviewLoop id and need "argv" and "timeoutMs".
- Task blocks: {kind:"text", text, ref:null} for instructions, {kind:"goal", text:null, ref:null} to insert the user's goal.
- "acceptance" lists what must hold at the end: verifyKind "check" with verifyRef = check step id, "review" with verifyRef = reviewer member key, or "manual" with verifyRef null.
- Mark anything the user did not say as source "inferred". Put requirements you cannot express in "unsupported" and assumptions you made in "assumptions".

User request:
${USER_REQUEST}`;

type ProbeResult = {
  provider: string;
  schemaAccepted: boolean;
  outputValid: boolean;
  converted: boolean;
  seconds: number;
  details: string[];
};

function evaluate(provider: string, started: number, raw: unknown, details: string[]): ProbeResult {
  const result: ProbeResult = {
    provider,
    schemaAccepted: true,
    outputValid: false,
    converted: false,
    seconds: Math.round((Date.now() - started) / 1000),
    details,
  };
  if (!validate(raw)) {
    details.push(`schema validation errors: ${JSON.stringify(validate.errors?.slice(0, 5))}`);
    return result;
  }
  result.outputValid = true;
  const converted = convertPlannedWorkflow(raw as PlannedWorkflow);
  if (!converted.ok) {
    details.push(`conversion errors: ${converted.errors.map((e) => `${e.path}: ${e.message}`).join(' | ')}`);
    return result;
  }
  result.converted = true;
  const spec = converted.spec;
  details.push(
    `members: ${spec.members.map((m) => `${m.key}=${m.agent}/${m.role}(${m.source})`).join(', ')}`,
    `steps: ${JSON.stringify(spec.steps.map((s) => ({ id: s.id, kind: s.kind })))}`,
    `acceptance: ${spec.acceptance.map((a) => `${a.id}:${a.verify.kind}(${a.source})`).join(', ')}`,
    `unsupported: ${JSON.stringify(spec.unsupported)}; assumptions: ${JSON.stringify(spec.assumptions)}`,
  );
  return result;
}

async function probeClaude(workdir: string): Promise<ProbeResult> {
  const started = Date.now();
  const details: string[] = [];
  let structured: unknown;
  try {
    for await (const message of query({
      prompt: PROMPT,
      options: {
        cwd: workdir,
        tools: [],
        mcpServers: {},
        settingSources: [],
        permissionMode: 'default',
        maxTurns: 4,
        outputFormat: { type: 'json_schema', schema },
        ...(process.env.CLAUDE_PROBE_EXECUTABLE
          ? { pathToClaudeCodeExecutable: process.env.CLAUDE_PROBE_EXECUTABLE }
          : {}),
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') details.push(`model: ${message.model}`);
      if (message.type === 'result') {
        details.push(`result subtype: ${message.subtype}`);
        if (message.subtype === 'success') structured = message.structured_output;
        else details.push(`errors: ${JSON.stringify((message as { errors?: unknown }).errors ?? null)}`);
      }
    }
  } catch (error) {
    details.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    return { provider: 'claude', schemaAccepted: false, outputValid: false, converted: false, seconds: 0, details };
  }
  if (structured === undefined) {
    return {
      provider: 'claude',
      schemaAccepted: false,
      outputValid: false,
      converted: false,
      seconds: Math.round((Date.now() - started) / 1000),
      details,
    };
  }
  return evaluate('claude', started, structured, details);
}

async function probeCodex(workdir: string): Promise<ProbeResult> {
  const started = Date.now();
  const details: string[] = [];
  const schemaPath = path.join(workdir, 'schema.json');
  const outPath = path.join(workdir, 'last-message.json');
  writeFileSync(schemaPath, JSON.stringify(schema));
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outPath,
    PROMPT,
  ];
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.env.CODEX_PROBE_EXECUTABLE ?? 'codex', args, { cwd: workdir, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ code: exitCode, stderr: err });
    });
  });
  details.push(`exit code: ${code}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    details.push(`no parsable output; stderr head: ${stderr.trim().split('\n').slice(0, 12).join(' | ')}`);
    return {
      provider: 'codex',
      schemaAccepted: false,
      outputValid: false,
      converted: false,
      seconds: Math.round((Date.now() - started) / 1000),
      details,
    };
  }
  return evaluate('codex', started, raw, details);
}

async function main() {
  const only = process.argv[2];
  const results: ProbeResult[] = [];
  for (const [name, probe] of [
    ['claude', probeClaude],
    ['codex', probeCodex],
  ] as const) {
    if (only && only !== name) continue;
    const workdir = mkdtempSync(path.join(tmpdir(), `aegis-planner-probe-${name}-`));
    console.log(`[probe] ${name} …`);
    try {
      results.push(await probe(workdir));
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
  for (const r of results) {
    console.log(
      `\n== ${r.provider}: schemaAccepted=${r.schemaAccepted} outputValid=${r.outputValid} converted=${r.converted} (${r.seconds}s)`,
    );
    for (const line of r.details) console.log(`   ${line}`);
  }
  process.exit(results.every((r) => r.converted) ? 0 : 1);
}

void main();
