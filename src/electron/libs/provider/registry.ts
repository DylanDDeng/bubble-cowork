import type { ProviderAdapter, ProviderKind } from './types';

const adapters = new Map<ProviderKind, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.provider, adapter);
}

export function getAdapter(provider: ProviderKind): ProviderAdapter | null {
  return adapters.get(provider) || null;
}

export function listAdapters(): ProviderAdapter[] {
  return Array.from(adapters.values());
}

export function hasAdapter(provider: ProviderKind): boolean {
  return adapters.has(provider);
}

export function clearAdapters(): void {
  adapters.clear();
}
