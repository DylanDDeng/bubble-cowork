// JavaScriptCore entry for the Swift app (AegisKit/Core). Every function takes and
// returns JSON strings; failures come back as {"error": "..."} instead of throwing.
import type { RemoteAgentOptions, RemoteMessage } from "../../../src/shared/remote/protocol";
import { catalogFor } from "./agents";
import { describeRequest, parsePatch, requestSummary } from "./patch";
import { renderSession } from "./session";

const guard =
  <T>(fn: (input: T) => unknown) =>
  (json: string): string => {
    try {
      return JSON.stringify(fn(JSON.parse(json) as T));
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  };

/** catalogFor() with its closures evaluated for every model, so Swift gets plain data. */
function catalog({ provider, options }: { provider: string; options?: RemoteAgentOptions }) {
  const c = catalogFor(provider, options);
  const perModel: Record<string, { efforts: { value: string; label: string }[]; defaultEffort: string | null; fast: boolean }> = {};
  const values = new Set([c.defaultModel, ...c.models.map((m) => m.value)]);
  for (const value of values) {
    perModel[value] = {
      efforts: c.effortsFor(value).map((e) => ({ value: e, label: c.effortLabel(e) })),
      defaultEffort: c.defaultEffortFor(value),
      fast: c.fastFor(value),
    };
  }
  return {
    provider: c.provider,
    models: c.models.map((m) => ({
      value: m.value,
      label: m.label,
      description: m.description ?? null,
      compatibleProviderId: m.compatibleProviderId ?? null,
    })),
    defaultModel: c.defaultModel,
    perModel,
    permissionModes: c.permissionModes.map((p) => ({ mode: p.mode, label: p.label, tone: p.tone ?? null })),
    defaultPermission: c.defaultPermission,
    supportsPlan: c.supportsPlan,
  };
}

const api = {
  renderSession: guard((input: { messages: RemoteMessage[]; running: boolean; status: string }) =>
    renderSession(input.messages, input.running, input.status),
  ),
  catalog: guard(catalog),
  parsePatch: guard((input: { patch: string }) => parsePatch(input.patch)),
  describeRequest: guard((input: { detail: string }) => ({
    ...describeRequest(input.detail),
    summary: requestSummary(input.detail),
  })),
};

(globalThis as unknown as { AegisCore: typeof api }).AegisCore = api;
