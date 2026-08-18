import { EventEmitter } from 'events';
import {
  AEGIS_COMPUTER_USE_SERVER_NAME,
  canonicalizeComputerUseApp,
  computerUseRiskRank,
  isComputerUseMutatingTool,
  isComputerUseServerName,
  isDeniedComputerUseTarget,
  type ComputerUseGrantView,
} from '../../shared/computer-use';
import type { McpToolApprovalElicitation } from './codex-computer-use-elicitation';

export interface ComputerUseGrant extends ComputerUseGrantView {}

function grantKey(input: {
  threadId: string;
  providerThreadId: string | null;
  server: string;
  tool: string;
  app: string;
}): string {
  return [
    input.threadId,
    input.providerThreadId || '',
    input.server.trim().toLowerCase(),
    input.tool.trim().toLowerCase(),
    input.app.trim().toLowerCase(),
  ].join('\0');
}

export class ComputerUseGrantRegistry extends EventEmitter {
  private grants = new Map<string, ComputerUseGrant>();

  list(threadId?: string): ComputerUseGrantView[] {
    const values = [...this.grants.values()];
    return threadId ? values.filter((grant) => grant.threadId === threadId) : values;
  }

  emitChange(threadId: string, reason: string): void {
    this.emit('change', { threadId, grants: this.list(threadId), reason });
  }

  isCreatable(elicitation: McpToolApprovalElicitation): boolean {
    return elicitation.grantEligible;
  }

  createFromElicitation(input: {
    threadId: string;
    generation: number;
    elicitation: McpToolApprovalElicitation;
  }): ComputerUseGrantView | null {
    if (!this.isCreatable(input.elicitation)) return null;
    const app = canonicalizeComputerUseApp(input.elicitation.canonicalApp);
    const tool = input.elicitation.toolName?.trim() || null;
    const server = input.elicitation.server?.trim() || null;
    if (!app || !tool || !server) return null;
    const grant: ComputerUseGrant = {
      key: grantKey({
        threadId: input.threadId,
        providerThreadId: input.elicitation.providerThreadId,
        server,
        tool,
        app,
      }),
      threadId: input.threadId,
      providerThreadId: input.elicitation.providerThreadId,
      generation: input.generation,
      server,
      tool,
      app,
      maxRisk: computerUseRiskRank(input.elicitation.riskLevel),
      createdAt: Date.now(),
    };
    this.grants.set(grant.key, grant);
    this.emitChange(input.threadId, 'granted');
    return grant;
  }

  match(input: {
    threadId: string;
    generation: number;
    elicitation: McpToolApprovalElicitation;
  }): ComputerUseGrantView | null {
    if (!input.elicitation.grantEligible) return null;
    const app = canonicalizeComputerUseApp(input.elicitation.canonicalApp);
    const tool = input.elicitation.toolName?.trim() || null;
    const server = input.elicitation.server?.trim() || null;
    if (!app || !tool || !server) return null;
    const key = grantKey({
      threadId: input.threadId,
      providerThreadId: input.elicitation.providerThreadId,
      server,
      tool,
      app,
    });
    const grant = this.grants.get(key);
    if (!grant) return null;
    if (grant.generation !== input.generation) return null;
    if (computerUseRiskRank(input.elicitation.riskLevel) > grant.maxRisk) return null;
    return grant;
  }

  revoke(threadId: string, key?: string): ComputerUseGrantView[] {
    if (key) {
      const grant = this.grants.get(key);
      if (!grant || grant.threadId !== threadId) return this.list(threadId);
      this.grants.delete(key);
      this.emitChange(threadId, 'revoked');
      return this.list(threadId);
    }
    return this.revokeThread(threadId);
  }

  revokeThread(threadId: string, reason = 'revoked'): ComputerUseGrantView[] {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.threadId === threadId) {
        this.grants.delete(key);
        changed = true;
      }
    }
    if (changed) this.emitChange(threadId, reason);
    return [];
  }

  revokeAll(reason = 'revoked'): void {
    const threadIds = new Set([...this.grants.values()].map((grant) => grant.threadId));
    this.grants.clear();
    for (const threadId of threadIds) {
      this.emitChange(threadId, reason);
    }
  }
}

export const computerUseGrants = new ComputerUseGrantRegistry();
computerUseGrants.setMaxListeners(50);

export function isStructuredComputerUseGrantTarget(
  elicitation: Pick<McpToolApprovalElicitation, 'server' | 'toolName' | 'isNodeRepl' | 'canonicalApp'>
): boolean {
  return (
    isComputerUseServerName(elicitation.server) &&
    elicitation.server === AEGIS_COMPUTER_USE_SERVER_NAME &&
    Boolean(elicitation.toolName && isComputerUseMutatingTool(elicitation.toolName)) &&
    !elicitation.isNodeRepl &&
    Boolean(canonicalizeComputerUseApp(elicitation.canonicalApp)) &&
    !isDeniedComputerUseTarget(elicitation.canonicalApp)
  );
}
