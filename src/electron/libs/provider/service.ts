import { EventEmitter } from 'events';
import type {
  ProviderAdapter,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionDirectory,
  ProviderSessionStartInput,
  ProviderService,
} from './types';
import * as registry from './registry';
import { providerSessionDirectory } from './directory';
import type { PermissionResult } from '../../../shared/types';
import type {
  ProviderComposerCapabilities,
  CodexRateLimitReport,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderInstallPluginInput,
  ProviderReadPluginInput,
  ProviderUninstallPluginInput,
  ProviderReadPluginResult,
} from '../../../shared/types';

function isProviderKind(provider: string): provider is ProviderKind {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'kimi' || provider === 'grok' || provider === 'pi' || provider === 'qoder';
}

class ProviderServiceImpl implements ProviderService {
  readonly events = new EventEmitter();
  readonly directory: ProviderSessionDirectory = providerSessionDirectory;

  private adapterListeners = new WeakMap<ProviderAdapter, (event: ProviderRuntimeEvent) => void>();

  registerAdapter(adapter: ProviderAdapter): void {
    registry.registerAdapter(adapter);

    // Forward all adapter events into the unified service event stream
    const listener = (event: ProviderRuntimeEvent) => {
      this.events.emit('event', event);
      // Also emit by specific event type for convenience
      if (event.type === 'error') {
        this.events.emit('provider_error', event);
        return;
      }
      this.events.emit(event.type, event);
    };
    adapter.events.on('event', listener);
    this.adapterListeners.set(adapter, listener);
  }

  getAdapter(provider: ProviderKind): ProviderAdapter | null {
    return registry.getAdapter(provider);
  }

  listAdapters(): ProviderAdapter[] {
    return registry.listAdapters();
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    const provider = input.provider || this.directory.getProvider(input.threadId) || 'codex';
    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    // Register before adapter.startSession resolves: ACP providers can request
    // tool permissions while starting the first turn.
    this.directory.upsert({
      threadId: input.threadId,
      provider,
      status: 'connecting',
      resumeCursor: input.resumeSessionId || null,
    });

    let session: ProviderSession;
    try {
      session = await adapter.startSession(input);
    } catch (error) {
      this.directory.remove(input.threadId);
      throw error;
    }

    // Persist binding with resume cursor
    this.directory.upsert({
      threadId: input.threadId,
      provider,
      status: session.status,
      resumeCursor: session.providerSessionId,
    });

    return session;
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const provider = this.directory.getProvider(input.threadId);
    if (!provider) {
      throw new Error(`No provider binding found for thread "${input.threadId}"`);
    }

    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    await adapter.sendTurn(input);
  }

  async stopSession(threadId: string): Promise<void> {
    const provider = this.directory.getProvider(threadId);
    if (!provider) {
      return;
    }

    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      return;
    }

    await adapter.stopSession(threadId);
    this.directory.remove(threadId);
  }

  async stopAll(): Promise<void> {
    const adapters = registry.listAdapters();
    await Promise.all(adapters.map((adapter) => adapter.stopAll()));
    // Clear directory after all stopped
    const threadIds = this.directory.listThreadIds();
    for (const threadId of threadIds) {
      this.directory.remove(threadId);
    }
  }

  listSessions(): ProviderSession[] {
    const adapters = registry.listAdapters();
    return adapters.flatMap((adapter) => adapter.listSessions());
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: PermissionResult
  ): Promise<void> {
    const provider = this.directory.getProvider(threadId);
    if (!provider) {
      throw new Error(`No provider binding found for thread "${threadId}"`);
    }

    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    await adapter.respondToRequest(threadId, requestId, decision);
  }

  getComposerCapabilities(provider: ProviderKind): ProviderComposerCapabilities {
    const adapter = registry.getAdapter(provider);
    if (!adapter?.getComposerCapabilities) {
      return {
        provider,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: false,
      };
    }

    return adapter.getComposerCapabilities();
  }

  async getRateLimits(provider: ProviderKind): Promise<CodexRateLimitReport | null> {
    const adapter = registry.getAdapter(provider);
    if (!adapter?.getRateLimits) {
      return null;
    }

    return adapter.getRateLimits();
  }

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    if (!isProviderKind(input.provider)) {
      return { skills: [], source: 'unsupported', cached: false };
    }
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.listSkills) {
      return { skills: [], source: 'unsupported', cached: false };
    }

    return adapter.listSkills(input);
  }

  async listPlugins(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult> {
    if (!isProviderKind(input.provider)) {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        remoteSyncError: null,
        featuredPluginIds: [],
        source: 'unsupported',
        cached: false,
      };
    }
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.listPlugins) {
      return {
        marketplaces: [],
        marketplaceLoadErrors: [],
        remoteSyncError: null,
        featuredPluginIds: [],
        source: 'unsupported',
        cached: false,
      };
    }

    return adapter.listPlugins(input);
  }

  async readPlugin(input: ProviderReadPluginInput): Promise<ProviderReadPluginResult> {
    if (!isProviderKind(input.provider)) {
      throw new Error(`Provider "${input.provider}" does not support plugin detail discovery.`);
    }
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.readPlugin) {
      throw new Error(`Provider "${input.provider}" does not support plugin detail discovery.`);
    }

    return adapter.readPlugin(input);
  }

  async installPlugin(input: ProviderInstallPluginInput): Promise<void> {
    if (!isProviderKind(input.provider)) {
      throw new Error(`Provider "${input.provider}" does not support plugin installation.`);
    }
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.installPlugin) {
      throw new Error(`Provider "${input.provider}" does not support plugin installation.`);
    }

    return adapter.installPlugin(input);
  }

  async uninstallPlugin(input: ProviderUninstallPluginInput): Promise<void> {
    if (!isProviderKind(input.provider)) {
      throw new Error(`Provider "${input.provider}" does not support plugin removal.`);
    }
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.uninstallPlugin) {
      throw new Error(`Provider "${input.provider}" does not support plugin removal.`);
    }

    return adapter.uninstallPlugin(input);
  }

  /**
   * Run a single prompt and return the response text.
   * Useful for title generation and session bootstrapping.
   */
  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    const provider = input.provider || this.directory.getProvider(input.threadId) || 'codex';
    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    if (adapter.runOneShot) {
      return adapter.runOneShot(input);
    }

    let text = '';
    let deltaText = '';
    let sessionId: string | undefined;
    let model: string | undefined;
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectDone(new Error(`${adapter.displayName} did not finish one-shot prompt within 300000ms.`));
    }, 300_000);
    timeout.unref?.();

    const settleSuccess = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };

    const settleError = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectDone(error);
    };

    const listener = (event: ProviderRuntimeEvent) => {
      if (event.threadId !== input.threadId) {
        return;
      }

      if (event.type === 'system_init') {
        sessionId = event.sessionId;
        model = event.model || model;
        return;
      }

      if (event.type === 'message' && event.message.type === 'stream_event') {
        const eventDelta = event.message.event.delta;
        if (eventDelta?.type === 'text_delta' && typeof eventDelta.text === 'string') {
          deltaText += eventDelta.text;
        }
        return;
      }

      if (event.type === 'message' && event.message.type === 'assistant') {
        const content = event.message.message.content as Array<{ type: string; text?: string }>;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            text += block.text;
          }
        }
        return;
      }

      if (event.type === 'message' && event.message.type === 'result') {
        settleSuccess();
        return;
      }

      if (event.type === 'status_change' && event.status === 'completed') {
        settleSuccess();
        return;
      }

      if (event.type === 'error') {
        settleError(event.error);
      }
    };

    this.events.on('event', listener);

    try {
      const session = await this.startSession(input);
      sessionId = session.providerSessionId || sessionId;
      model = session.model || model;
      await done;

      return {
        text: (text || deltaText).trim(),
        sessionId,
        model,
      };
    } finally {
      clearTimeout(timeout);
      this.events.off('event', listener);
      await this.stopSession(input.threadId);
    }
  }
}

// Singleton instance
let serviceInstance: ProviderService | null = null;

export function getProviderService(): ProviderService {
  if (!serviceInstance) {
    serviceInstance = new ProviderServiceImpl();
  }
  return serviceInstance;
}

export function resetProviderService(): void {
  serviceInstance = null;
}
