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
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from '../../../shared/types';

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
    const provider = this.directory.getProvider(input.threadId) || 'codex';
    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    const session = await adapter.startSession(input);

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

  async listSkills(input: ProviderListSkillsInput): Promise<ProviderListSkillsResult> {
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.listSkills) {
      return { skills: [], source: 'unsupported', cached: false };
    }

    return adapter.listSkills(input);
  }

  async listPlugins(input: ProviderListPluginsInput): Promise<ProviderListPluginsResult> {
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
    const adapter = registry.getAdapter(input.provider);
    if (!adapter?.readPlugin) {
      throw new Error(`Provider "${input.provider}" does not support plugin detail discovery.`);
    }

    return adapter.readPlugin(input);
  }

  /**
   * Run a single prompt and return the response text.
   * Useful for title generation and session bootstrapping.
   */
  async runOneShot(
    input: ProviderSessionStartInput
  ): Promise<{ text: string; sessionId?: string; model?: string }> {
    const provider = this.directory.getProvider(input.threadId) || 'codex';
    const adapter = registry.getAdapter(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider "${provider}"`);
    }

    const session = await adapter.startSession(input);
    let text = '';

    const listener = (event: ProviderRuntimeEvent) => {
      if (event.type === 'message' && event.message.type === 'assistant') {
        const content = event.message.message.content as Array<{ type: string; text?: string }>;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            text += block.text;
          }
        }
      }
    };

    adapter.events.on('event', listener);

    try {
      await adapter.sendTurn({
        threadId: input.threadId,
        prompt: input.prompt,
	        attachments: input.attachments,
	        model: input.model,
	        codexExecutionMode: input.codexExecutionMode,
	        codexPermissionMode: input.codexPermissionMode,
	        codexReasoningEffort: input.codexReasoningEffort,
	        codexFastMode: input.codexFastMode,
	      });

      // Wait a bit for the turn to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      return {
        text: text.trim(),
        sessionId: session.providerSessionId,
        model: session.model,
      };
    } finally {
      adapter.events.off('event', listener);
      await adapter.stopSession(input.threadId);
      this.directory.remove(input.threadId);
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
