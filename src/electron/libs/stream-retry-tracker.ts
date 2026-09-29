import type { RetryOutputSnapshot, StreamMessage } from '../../shared/types';
import { removeCommittedRetryOutput, resolvesStreamRetry, type ApiRetryMessage, type RetryResolvedMessage } from '../../shared/stream-retry';

/** Main-process ownership makes retry history independent of open renderer windows. */
export class StreamRetryTracker {
  private thinking = '';
  private text = '';
  private retry: ApiRetryMessage | undefined;

  reset(): void {
    this.thinking = '';
    this.text = '';
    this.retry = undefined;
  }

  observe(message: StreamMessage, attribution: Pick<RetryOutputSnapshot, 'agentId' | 'agentRunId'> = {}): {
    message: StreamMessage;
    resolved?: RetryResolvedMessage;
  } {
    if (message.parentToolUseId) return { message };
    if (message.type === 'system' && message.subtype === 'api_retry') {
      const createdAt = message.createdAt ?? Date.now();
      const snapshot = this.retry?.snapshot ?? (this.thinking || this.text ? {
        uuid: `interrupted:${message.uuid}`, createdAt, thinking: this.thinking, text: this.text, ...attribution,
      } : undefined);
      this.retry = { ...message, createdAt, ...attribution, snapshot };
      return { message: this.retry };
    }

    let resolved: RetryResolvedMessage | undefined;
    if (this.retry && resolvesStreamRetry(message)) {
      resolved = {
        type: 'system', subtype: 'api_retry_resolved', uuid: `resolved:${this.retry.uuid}`,
        session_id: this.retry.session_id, retryId: this.retry.uuid, createdAt: Date.now(),
        snapshot: this.retry.snapshot ? removeCommittedRetryOutput(this.retry.snapshot, message) : undefined,
      };
      this.reset();
    }
    if (!this.retry) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'thinking_delta') this.thinking += event.delta.thinking ?? '';
          if (event.delta?.type === 'text_delta') this.text += event.delta.text ?? '';
        } else if (event.type === 'content_block_stop') {
          this.thinking = '';
          this.text = '';
        }
      } else if (message.type === 'assistant' || message.type === 'result' || message.type === 'user_prompt'
        || (message.type === 'user' && resolvesStreamRetry(message))) {
        this.reset();
      }
    }
    return { message, resolved };
  }
}
