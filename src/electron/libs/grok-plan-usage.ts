import { spawn } from 'child_process';
import { homedir } from 'os';
import { buildGrokEnv, resolveGrokBinary } from './grok-cli';
import { AcpJsonRpcClient } from './provider/acp-json-rpc-client';
import type { GrokPlanUsagePeriod, GrokPlanUsageReport } from '../../shared/types';

const USAGE_TTL_MS = 45_000;
const USAGE_TIMEOUT_MS = 15_000;

let cached: GrokPlanUsageReport | null = null;
let inflight: Promise<GrokPlanUsageReport> | null = null;

/**
 * Fetch the signed-in grok.com account's subscription usage (the data behind
 * the Grok Build TUI's /usage screen) through a short-lived `grok agent stdio`
 * process, using the `_x.ai/billing` ACP extension method.
 *
 * Results are cached briefly so a polling Usage page does not respawn the CLI
 * on every tick. Throws when the probe fails and no cached report exists.
 */
export function getGrokPlanUsage(force = false): Promise<GrokPlanUsageReport> {
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (!inflight) {
    inflight = fetchPlanUsage()
      .then((report) => {
        cached = report;
        return report;
      })
      .catch((error) => {
        if (cached) {
          console.warn('[grok-plan-usage] probe failed, serving cached report:', error);
          return cached;
        }
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function fetchPlanUsage(): Promise<GrokPlanUsageReport> {
  const binary = await resolveGrokBinary();
  if (!binary) {
    throw new Error('Grok Build CLI was not found. Install Grok Build or set GROK_CODE_PATH.');
  }

  const proc = spawn(binary, ['agent', 'stdio'], {
    cwd: homedir(),
    env: buildGrokEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rpc = new AcpJsonRpcClient(
    proc,
    () => {},
    // The pre-session probe should never receive agent-initiated requests;
    // reject them so neither side waits on the other.
    (request) => rpc.respond(request.id, undefined, { code: -32601, message: 'Method not found' }),
    () => {}
  );

  try {
    const billing = await withTimeout(
      (async () => {
        await rpc.request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        return rpc.request('_x.ai/billing', {});
      })(),
      USAGE_TIMEOUT_MS,
      'Grok usage probe timed out'
    );
    return parseBillingResult(billing);
  } finally {
    proc.kill();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function parseBillingResult(result: unknown): GrokPlanUsageReport {
  const root = asRecord(result);
  if (!root) {
    throw new Error('Grok billing probe returned no data.');
  }
  const config = asRecord(root.config);
  return {
    source: 'grok-acp',
    fetchedAt: Date.now(),
    subscriptionTier: asString(root.subscription_tier) ?? asString(root.subscriptionTier),
    creditUsagePercent: normalizePercent(asNumber(config?.creditUsagePercent)),
    currentPeriod: parsePeriod(config),
    onDemandCap: asWrappedNumber(config?.onDemandCap),
    onDemandUsed: asWrappedNumber(config?.onDemandUsed),
    prepaidBalance: asWrappedNumber(config?.prepaidBalance),
  };
}

function parsePeriod(config: Record<string, unknown> | null): GrokPlanUsagePeriod | null {
  const period = asRecord(config?.currentPeriod);
  const startsAt = parseTimestamp(period?.start) ?? parseTimestamp(config?.billingPeriodStart);
  const endsAt = parseTimestamp(period?.end) ?? parseTimestamp(config?.billingPeriodEnd);
  if (!period && startsAt === null && endsAt === null) {
    return null;
  }
  return {
    type: asString(period?.type),
    startsAt,
    endsAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Money-ish fields arrive as either a raw number or a `{ val: number }` wrapper. */
function asWrappedNumber(value: unknown): number | null {
  const direct = asNumber(value);
  if (direct !== null) {
    return direct;
  }
  return asNumber(asRecord(value)?.val);
}

function normalizePercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

function parseTimestamp(value: unknown): number | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
