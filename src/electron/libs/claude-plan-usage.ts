import { homedir } from 'os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getClaudeEnv, sanitizeOfficialClaudeEnv } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';
import type {
  ClaudePlanModelWindow,
  ClaudePlanUsageReport,
  ClaudePlanUsageWindow,
} from '../../shared/types';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

const USAGE_TTL_MS = 45_000;
const USAGE_TIMEOUT_MS = 25_000;

let cached: ClaudePlanUsageReport | null = null;
let inflight: Promise<ClaudePlanUsageReport> | null = null;

function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string
  ) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
}

/**
 * Fetch the signed-in claude.ai account's plan rate-limit utilization (the
 * data behind the CLI's /usage screen) through the Agent SDK control channel.
 * Same probe pattern as claude-model-catalog: an idle streaming session that
 * never sends a prompt, using the sanitized official env so third-party
 * ANTHROPIC_BASE_URL setups never shape the numbers.
 *
 * Results are cached briefly so a polling Usage page does not respawn the CLI
 * on every tick. Throws when the probe fails and no cached report exists.
 */
export function getClaudePlanUsage(force = false): Promise<ClaudePlanUsageReport> {
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
          console.warn('[claude-plan-usage] probe failed, serving cached report:', error);
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

async function fetchPlanUsage(): Promise<ClaudePlanUsageReport> {
  const runtime = getClaudeCodeRuntime();
  if (!runtime.pathToClaudeCodeExecutable) {
    throw new Error('Claude Code runtime is not available.');
  }

  const sdk = await loadClaudeAgentSdk();
  // options.env is the child's COMPLETE environment (not merged with
  // process.env), so it must include the full parent env or the CLI cannot
  // resolve HOME and loses the signed-in claude.ai account.
  const env = {
    ...sanitizeOfficialClaudeEnv({ ...process.env, ...getClaudeEnv() }),
    ...runtime.env,
  };
  const abortController = new AbortController();

  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  const query = sdk.query({
    prompt: idlePrompt,
    options: {
      cwd: homedir(),
      abortController,
      env,
      executable: runtime.executable as unknown as 'node',
      executableArgs: runtime.executableArgs,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      settingSources: [],
    },
  });

  try {
    const usage = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Claude usage probe timed out')), USAGE_TIMEOUT_MS);
      }),
    ]);

    const limits = usage.rate_limits;
    return {
      source: 'claude-agent-sdk',
      fetchedAt: Date.now(),
      subscriptionType: usage.subscription_type ?? null,
      rateLimitsAvailable: Boolean(usage.rate_limits_available),
      fiveHour: parseWindow(limits?.five_hour),
      sevenDay: parseWindow(limits?.seven_day),
      sevenDayOpus: parseWindow(limits?.seven_day_opus),
      sevenDaySonnet: parseWindow(limits?.seven_day_sonnet),
      modelScoped: parseModelScoped(limits?.model_scoped),
      extraUsage: parseExtraUsage(limits?.extra_usage),
    };
  } finally {
    abortController.abort();
  }
}

function parseWindow(
  value: { utilization: number | null; resets_at: string | null } | null | undefined
): ClaudePlanUsageWindow | null {
  if (!value) {
    return null;
  }
  return {
    utilization: normalizePercent(value.utilization),
    resetsAt: parseResetsAt(value.resets_at),
  };
}

function parseModelScoped(
  value:
    | Array<{ display_name: string; utilization: number | null; resets_at: string | null }>
    | undefined
): ClaudePlanModelWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => entry && typeof entry.display_name === 'string')
    .map((entry) => ({
      displayName: entry.display_name,
      utilization: normalizePercent(entry.utilization),
      resetsAt: parseResetsAt(entry.resets_at),
    }));
}

function parseExtraUsage(
  value:
    | {
        is_enabled: boolean;
        monthly_limit: number | null;
        used_credits: number | null;
        utilization: number | null;
        currency?: string | null;
      }
    | null
    | undefined
): ClaudePlanUsageReport['extraUsage'] {
  if (!value) {
    return null;
  }
  return {
    isEnabled: Boolean(value.is_enabled),
    monthlyLimit: typeof value.monthly_limit === 'number' ? value.monthly_limit : null,
    usedCredits: typeof value.used_credits === 'number' ? value.used_credits : null,
    utilization: normalizePercent(value.utilization),
    currency: typeof value.currency === 'string' ? value.currency : null,
  };
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
