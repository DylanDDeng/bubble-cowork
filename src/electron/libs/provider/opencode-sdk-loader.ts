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

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<OpenCodeSdkModule>;

let sdkPromise: Promise<OpenCodeSdkModule> | null = null;

export function loadOpenCodeSdk(): Promise<OpenCodeSdkModule> {
  if (!sdkPromise) {
    sdkPromise = importEsm('@opencode-ai/sdk');
  }
  return sdkPromise;
}
