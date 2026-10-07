// Product limits (plan §5.4). Structured outputs cannot express numeric
// bounds, so every one of these is enforced locally.

export type ProductLimits = {
  maxMembers: number;
  maxConcurrent: number;
  maxAgentSteps: number;
  maxRepairRounds: number;
  maxRepeat: number;
  maxDepth: number;
  maxSteps: number;
  maxCheckTimeoutMs: number;
};

export const DEFAULT_LIMITS: ProductLimits = {
  maxMembers: 6,
  maxConcurrent: 3,
  maxAgentSteps: 16,
  maxRepairRounds: 3,
  maxRepeat: 4,
  maxDepth: 3,
  maxSteps: 30,
  maxCheckTimeoutMs: 60 * 60_000,
};
