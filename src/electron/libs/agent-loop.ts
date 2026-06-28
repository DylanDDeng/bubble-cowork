import type { RunnerHandle, RunnerOptions } from '../types';
import { ensureAgentRuntimeRegistry, resolveRuntime } from './runtime';
import { getProviderService } from './provider/service';
import { CodexAdapter } from './provider/codex-adapter';
import { KimiAcpAdapter } from './provider/kimi-acp-adapter';
import { GrokAcpAdapter } from './provider/grok-acp-adapter';
import { OpenCodeSdkAdapter } from './provider/opencode-sdk-adapter';
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
  service.registerAdapter(new OpenCodeSdkAdapter());
  service.registerAdapter(new KimiAcpAdapter());
  service.registerAdapter(new GrokAcpAdapter());

  if (isDev()) {
    console.log('[ProviderService] initialized with adapters:', service.listAdapters().map((a) => a.provider));
  }
}

export function runAgentLoop(options: RunnerOptions): RunnerHandle {
  const provider = options.session.provider || 'claude';

  ensureProviderService();
  const service = getProviderService();

  if (service.getAdapter(provider)) {
    return runProviderServiceAgent(options);
  }

  ensureAgentRuntimeRegistry();
  const runtime = resolveRuntime(provider);
  return runtime.run(options);
}

function runProviderServiceAgent(options: RunnerOptions): RunnerHandle {
  ensureProviderService();
  const service = getProviderService();

  const threadId = options.session.id;
  const provider = options.session.provider || 'codex';
  let abortController = new AbortController();

  // Subscribe to provider events
  const handleEvent = (event: import('./provider/types').ProviderRuntimeEvent) => {
    if (abortController.signal.aborted) return;
    if (event.threadId !== threadId) return;

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
      console.error('[ProviderService] Permission request failed:', error);
    }
  }

  // Start the session
  const startPromise = service.startSession({
    provider,
    threadId,
    cwd: options.session.cwd || process.cwd(),
    prompt: options.prompt,
    attachments: options.attachments,
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    codexExecutionMode: options.codexExecutionMode,
    codexPermissionMode: options.codexPermissionMode,
    codexReasoningEffort: options.codexReasoningEffort,
    codexFastMode: options.codexFastMode,
    kimiPermissionMode: options.kimiPermissionMode,
    grokPermissionMode: options.grokPermissionMode,
    grokReasoningEffort: options.grokReasoningEffort,
    opencodePermissionMode: options.opencodePermissionMode,
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
        console.error('[ProviderService] Failed to stop session:', error);
      });
      service.events.off('event', handleEvent);
    },
    send: (
      prompt: string,
      attachments?: import('../../shared/types').Attachment[],
      model?: string,
      codexSkills?: import('../../shared/types').ProviderInputReference[],
      codexMentions?: import('../../shared/types').ProviderInputReference[],
      sendOptions?: {
        codexExecutionMode?: import('../../shared/types').CodexExecutionMode;
        codexPermissionMode?: import('../../shared/types').CodexPermissionMode;
        codexReasoningEffort?: import('../../shared/types').CodexReasoningEffort;
        codexFastMode?: boolean;
        kimiPermissionMode?: import('../../shared/types').KimiPermissionMode;
        grokPermissionMode?: import('../../shared/types').GrokPermissionMode;
        grokReasoningEffort?: import('../../shared/types').GrokReasoningEffort;
        opencodePermissionMode?: import('../../shared/types').OpenCodePermissionMode;
      }
    ) => {
      if (abortController.signal.aborted) return;

      service
        .sendTurn({
          threadId,
          prompt,
          attachments,
          model,
          codexExecutionMode: sendOptions?.codexExecutionMode ?? options.codexExecutionMode,
          codexPermissionMode: sendOptions?.codexPermissionMode ?? options.codexPermissionMode,
          codexReasoningEffort: sendOptions?.codexReasoningEffort ?? options.codexReasoningEffort,
          codexFastMode: sendOptions?.codexFastMode ?? options.codexFastMode,
          kimiPermissionMode: sendOptions?.kimiPermissionMode ?? options.kimiPermissionMode,
          grokPermissionMode: sendOptions?.grokPermissionMode ?? options.grokPermissionMode,
          grokReasoningEffort: sendOptions?.grokReasoningEffort ?? options.grokReasoningEffort,
          opencodePermissionMode:
            sendOptions?.opencodePermissionMode ?? options.opencodePermissionMode,
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
