import type { RunnerHandle, RunnerOptions } from '../types';
import { ensureAgentRuntimeRegistry, resolveRuntime } from './runtime';
import { getProviderService } from './provider/service';
import { CodexAdapter } from './provider/codex-adapter';
import { isDev } from '../util';

let providerServiceInitialized = false;

export function ensureProviderService(): void {
  if (providerServiceInitialized) {
    return;
  }
  providerServiceInitialized = true;

  const service = getProviderService();

  // Register Codex adapter (uses codex app-server)
  const codexAdapter = new CodexAdapter();
  service.registerAdapter(codexAdapter);

  if (isDev()) {
    console.log('[ProviderService] initialized with adapters:', service.listAdapters().map((a) => a.provider));
  }
}

export function runAgentLoop(options: RunnerOptions): RunnerHandle {
  const provider = options.session.provider || 'claude';

  // For Codex, use the new ProviderAdapter architecture
  if (provider === 'codex') {
    return runCodexViaProviderService(options);
  }

  // For Claude and OpenCode, keep using the existing RuntimeRegistry
  ensureAgentRuntimeRegistry();
  const runtime = resolveRuntime(provider);
  return runtime.run(options);
}

function runCodexViaProviderService(options: RunnerOptions): RunnerHandle {
  ensureProviderService();
  const service = getProviderService();

  const threadId = options.session.id;
  let abortController = new AbortController();

  // Subscribe to provider events
  const handleEvent = (event: import('./provider/types').ProviderRuntimeEvent) => {
    if (abortController.signal.aborted) return;

    switch (event.type) {
      case 'message': {
        options.onMessage(event.message);
        break;
      }
      case 'error': {
        options.onError?.(event.error);
        break;
      }
      case 'permission_request': {
        void handlePermissionRequest(event.requestId, event.toolName, event.input);
        break;
      }
      case 'system_init': {
        const initMessage: import('../../shared/types').StreamMessage = {
          type: 'system',
          subtype: 'init',
          session_id: event.sessionId,
          model: event.model || '',
          permissionMode: '',
          cwd: options.session.cwd || '',
          tools: [],
        };
        options.onMessage(initMessage);
        break;
      }
      case 'status_change': {
        // Status changes are handled implicitly through messages
        break;
      }
    }
  };

  service.events.on('event', handleEvent);

  async function handlePermissionRequest(
    requestId: string,
    toolName: string,
    input: unknown
  ): Promise<void> {
    try {
      const result = await options.onPermissionRequest(requestId, toolName, input);
      await service.respondToRequest(threadId, requestId, result);
    } catch (error) {
      console.error('[Codex Provider] Permission request failed:', error);
    }
  }

  // Start the session
  const startPromise = service.startSession({
    threadId,
    cwd: options.session.cwd || process.cwd(),
    prompt: options.prompt,
    attachments: options.attachments,
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    codexPermissionMode: options.codexPermissionMode,
    codexReasoningEffort: options.codexReasoningEffort,
    codexFastMode: options.codexFastMode,
    codexSkills: options.codexSkills,
    codexMentions: options.codexMentions,
  });

  // Wait for session start in background
  startPromise.catch((error) => {
    if (!abortController.signal.aborted) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    abort: () => {
      abortController.abort();
      service.stopSession(threadId).catch((error) => {
        console.error('[Codex Provider] Failed to stop session:', error);
      });
      service.events.off('event', handleEvent);
    },
    send: (
      prompt: string,
      attachments?: import('../../shared/types').Attachment[],
      model?: string,
      codexSkills?: import('../../shared/types').ProviderInputReference[],
      codexMentions?: import('../../shared/types').ProviderInputReference[]
    ) => {
      if (abortController.signal.aborted) return;

      service
        .sendTurn({
          threadId,
          prompt,
          attachments,
          model,
          codexSkills,
          codexMentions,
        })
        .catch((error) => {
          if (!abortController.signal.aborted) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
    },
  };
}
