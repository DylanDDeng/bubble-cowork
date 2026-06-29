export type OpenCodeSdkModule = {
  createOpencodeClient: (config: {
    baseUrl: string;
    directory?: string;
    fetch?: (request: Request) => ReturnType<typeof fetch>;
  }) => unknown;
  createOpencodeServer: (options?: {
    hostname?: string;
    port?: number;
    signal?: AbortSignal;
    timeout?: number;
    config?: Record<string, unknown>;
  }) => Promise<{
    url: string;
    close(): void;
  }>;
};

export type OpenCodeV2SdkModule = {
  createOpencodeClient: (config: {
    baseUrl: string;
    directory?: string;
    fetch?: (request: Request) => ReturnType<typeof fetch>;
  }) => unknown;
};

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<OpenCodeSdkModule | OpenCodeV2SdkModule>;

let sdkPromise: Promise<OpenCodeSdkModule> | null = null;
let sdkV2Promise: Promise<OpenCodeV2SdkModule> | null = null;

export function loadOpenCodeSdk(): Promise<OpenCodeSdkModule> {
  if (!sdkPromise) {
    sdkPromise = importEsm('@opencode-ai/sdk') as Promise<OpenCodeSdkModule>;
  }
  return sdkPromise;
}

export function loadOpenCodeV2Sdk(): Promise<OpenCodeV2SdkModule> {
  if (!sdkV2Promise) {
    sdkV2Promise = importEsm('@opencode-ai/sdk/v2') as Promise<OpenCodeV2SdkModule>;
  }
  return sdkV2Promise;
}
