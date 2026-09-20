import type { AgentProvider } from '../types';
import { useAgentUsageReport } from './useAgentUsageReport';

export function useRecentAgentUsage(provider: AgentProvider, enabled: boolean) {
  return useAgentUsageReport(provider, 30, enabled);
}
