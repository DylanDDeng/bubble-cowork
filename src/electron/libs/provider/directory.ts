import type { ProviderKind, ProviderRuntimeBinding, ProviderSessionDirectory, ProviderSessionStatus } from './types';

const bindings = new Map<string, ProviderRuntimeBinding>();

export const providerSessionDirectory: ProviderSessionDirectory = {
  upsert(binding: ProviderRuntimeBinding): void {
    bindings.set(binding.threadId, { ...binding });
  },

  getProvider(threadId: string): ProviderKind | null {
    const binding = bindings.get(threadId);
    return binding?.provider || null;
  },

  getBinding(threadId: string): ProviderRuntimeBinding | null {
    const binding = bindings.get(threadId);
    return binding ? { ...binding } : null;
  },

  remove(threadId: string): void {
    bindings.delete(threadId);
  },

  listThreadIds(): string[] {
    return Array.from(bindings.keys());
  },
};

// Helper to update just the status
export function updateBindingStatus(
  threadId: string,
  status: ProviderSessionStatus
): void {
  const binding = bindings.get(threadId);
  if (binding) {
    binding.status = status;
  }
}

// Helper to update just the resume cursor
export function updateBindingCursor(
  threadId: string,
  resumeCursor: string | null
): void {
  const binding = bindings.get(threadId);
  if (binding) {
    binding.resumeCursor = resumeCursor;
  }
}

// Helper to get all bindings (for persistence)
export function getAllBindings(): ProviderRuntimeBinding[] {
  return Array.from(bindings.values()).map((b) => ({ ...b }));
}

// Helper to clear all (for shutdown)
export function clearAllBindings(): void {
  bindings.clear();
}
