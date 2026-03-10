import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { getSession } from './session-store';
import { loadFeishuBridgeConfig } from './feishu-bridge-config';
import type {
  AgentProvider,
  Attachment,
  FeishuBridgeConfig,
  FeishuBridgeStatus,
  PermissionRequestPayload,
  PermissionResult,
  StreamMessage,
} from '../../shared/types';

type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
  };
};

type FeishuBridgeBinding = {
  chatId: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
};

type FeishuBridgeBindingsFile = {
  version: 1;
  bindings: FeishuBridgeBinding[];
};

type BridgeHandlers = {
  startSession: (input: {
    title: string;
    prompt: string;
    cwd: string;
    provider: AgentProvider;
    model?: string;
  }) => Promise<string | null>;
  continueSession: (input: {
    sessionId: string;
    prompt: string;
    provider: AgentProvider;
    model?: string;
  }) => Promise<boolean>;
  resolvePermission: (input: {
    sessionId: string;
    toolUseId: string;
    result: PermissionResult;
  }) => boolean;
};

const BINDINGS_PATH = () => join(app.getPath('userData'), 'feishu-bridge-bindings.json');

function loadBindings(): FeishuBridgeBindingsFile {
  const filePath = BINDINGS_PATH();
  if (!existsSync(filePath)) {
    return { version: 1, bindings: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<FeishuBridgeBindingsFile>;
    const bindings = Array.isArray(parsed.bindings)
      ? parsed.bindings.filter((binding): binding is FeishuBridgeBinding =>
          !!binding &&
          typeof binding.chatId === 'string' &&
          typeof binding.userId === 'string' &&
          typeof binding.sessionId === 'string'
        )
      : [];
    return { version: 1, bindings };
  } catch {
    return { version: 1, bindings: [] };
  }
}

function saveBindings(bindings: FeishuBridgeBinding[]): void {
  writeFileSync(BINDINGS_PATH(), JSON.stringify({ version: 1, bindings }, null, 2), 'utf-8');
}

function normalizeTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return (parsed.text || '').trim();
  } catch {
    return content.trim();
  }
}

function extractAssistantText(message: StreamMessage): string | null {
  if (message.type !== 'assistant') {
    return null;
  }

  const text = message.message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text || null;
}

function buildPermissionHelp(toolName: string, toolUseId: string): string {
  return [
    `Permission required for tool: ${toolName}`,
    '',
    'Reply with one of these commands:',
    `/perm allow ${toolUseId}`,
    `/perm allow_session ${toolUseId}`,
    `/perm deny ${toolUseId}`,
  ].join('\n');
}

class FeishuBridgeService {
  private handlers: BridgeHandlers | null = null;
  private status: FeishuBridgeStatus = {
    running: false,
    connected: false,
    activeBindings: 0,
  };
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private botOpenId: string | null = null;
  private bindings = loadBindings().bindings;
  private permissionIndex = new Map<string, { chatId: string; sessionId: string }>();

  setHandlers(handlers: BridgeHandlers): void {
    this.handlers = handlers;
  }

  getStatus(): FeishuBridgeStatus {
    return {
      ...this.status,
      botOpenId: this.botOpenId || undefined,
      activeBindings: this.bindings.length,
    };
  }

  private updateStatus(partial: Partial<FeishuBridgeStatus>): void {
    this.status = {
      ...this.status,
      ...partial,
      activeBindings: this.bindings.length,
    };
  }

  private validateConfig(config: FeishuBridgeConfig): string | null {
    if (!config.enabled) return 'Bridge is disabled.';
    if (!config.appId.trim()) return 'App ID is required.';
    if (!config.appSecret.trim()) return 'App Secret is required.';
    if (!config.defaultCwd.trim()) return 'Default workspace is required.';
    return null;
  }

  async start(): Promise<FeishuBridgeStatus> {
    if (this.status.running) {
      return this.getStatus();
    }

    const config = loadFeishuBridgeConfig();
    const validationError = this.validateConfig(config);
    if (validationError) {
      this.updateStatus({
        running: false,
        connected: false,
        lastError: validationError,
      });
      return this.getStatus();
    }

    try {
      this.restClient = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: lark.Domain.Feishu,
      });

      await this.resolveBotIdentity(config);

      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
          await this.handleIncomingEvent(data as FeishuMessageEventData, config);
        },
      });

      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: lark.Domain.Feishu,
      });
      this.wsClient.start({ eventDispatcher: dispatcher });

      this.updateStatus({
        running: true,
        connected: true,
        lastError: undefined,
      });
    } catch (error) {
      this.updateStatus({
        running: false,
        connected: false,
        lastError: error instanceof Error ? error.message : 'Failed to start Feishu bridge.',
      });
    }

    return this.getStatus();
  }

  async stop(): Promise<FeishuBridgeStatus> {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch {
        // ignore
      }
      this.wsClient = null;
    }

    this.restClient = null;
    this.permissionIndex.clear();
    this.botOpenId = null;
    this.updateStatus({
      running: false,
      connected: false,
    });
    return this.getStatus();
  }

  async maybeAutoStart(): Promise<void> {
    const config = loadFeishuBridgeConfig();
    if (config.enabled && config.autoStart) {
      await this.start();
    }
  }

  private async resolveBotIdentity(config: FeishuBridgeConfig): Promise<void> {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = (await tokenRes.json()) as { tenant_access_token?: string };
    if (!tokenData.tenant_access_token) {
      return;
    }

    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const botData = (await botRes.json()) as { bot?: { open_id?: string } };
    this.botOpenId = botData.bot?.open_id || null;
  }

  private findBinding(chatId: string): FeishuBridgeBinding | null {
    const binding = this.bindings.find((item) => item.chatId === chatId) || null;
    if (!binding) return null;
    if (!getSession(binding.sessionId)) {
      this.bindings = this.bindings.filter((item) => item.chatId !== chatId);
      saveBindings(this.bindings);
      return null;
    }
    return binding;
  }

  private upsertBinding(chatId: string, userId: string, sessionId: string): void {
    const now = Date.now();
    const nextBinding: FeishuBridgeBinding = {
      chatId,
      userId,
      sessionId,
      createdAt: this.findBinding(chatId)?.createdAt || now,
      updatedAt: now,
    };
    this.bindings = [...this.bindings.filter((item) => item.chatId !== chatId), nextBinding];
    saveBindings(this.bindings);
    this.updateStatus({});
  }

  private clearBinding(chatId: string): void {
    this.bindings = this.bindings.filter((item) => item.chatId !== chatId);
    saveBindings(this.bindings);
    this.updateStatus({});
  }

  private isAllowedUser(config: FeishuBridgeConfig, userId: string): boolean {
    const allowed = config.allowedUserIds
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (allowed.length === 0) {
      return true;
    }
    return allowed.includes(userId);
  }

  private async handleIncomingEvent(
    data: FeishuMessageEventData,
    config: FeishuBridgeConfig
  ): Promise<void> {
    if (!this.handlers || !this.restClient) {
      return;
    }

    if (data.sender.sender_type === 'bot') {
      return;
    }

    const message = data.message;
    if (!message || message.chat_type !== 'p2p' || message.message_type !== 'text') {
      return;
    }

    const chatId = message.chat_id;
    const userId =
      data.sender.sender_id?.open_id ||
      data.sender.sender_id?.user_id ||
      data.sender.sender_id?.union_id ||
      '';

    if (!this.isAllowedUser(config, userId)) {
      return;
    }

    const text = normalizeTextContent(message.content);
    if (!text) {
      return;
    }

    this.updateStatus({ lastInboundAt: Date.now() });

    if (text === '/new') {
      this.clearBinding(chatId);
      await this.sendText(chatId, 'Started a fresh bridge session. Send your next message to create a new conversation.');
      return;
    }

    if (text.startsWith('/perm ')) {
      const parts = text.split(/\s+/);
      if (parts.length >= 3) {
        const action = parts[1];
        const toolUseId = parts.slice(2).join(' ');
        const permission = this.permissionIndex.get(toolUseId);
        if (!permission || permission.chatId !== chatId) {
          await this.sendText(chatId, 'Permission request not found or already resolved.');
          return;
        }

        const result: PermissionResult =
          action === 'allow_session'
            ? { behavior: 'allow', scope: 'session' }
            : action === 'allow'
              ? { behavior: 'allow', scope: 'once' }
              : { behavior: 'deny' };

        const resolved = this.handlers.resolvePermission({
          sessionId: permission.sessionId,
          toolUseId,
          result,
        });

        if (resolved) {
          this.permissionIndex.delete(toolUseId);
          await this.sendText(
            chatId,
            action === 'deny' ? 'Permission denied.' : 'Permission approved.'
          );
        } else {
          await this.sendText(chatId, 'Permission request is no longer pending.');
        }
      }
      return;
    }

    const existingBinding = this.findBinding(chatId);
    if (!existingBinding) {
      const title = text.slice(0, 40) + (text.length > 40 ? '...' : '');
      const sessionId = await this.handlers.startSession({
        title,
        prompt: text,
        cwd: config.defaultCwd,
        provider: config.provider,
        model: config.model || undefined,
      });

      if (sessionId) {
        this.upsertBinding(chatId, userId, sessionId);
      } else {
        await this.sendText(chatId, 'Failed to start a new session. Check bridge settings and logs.');
      }
      return;
    }

    const continued = await this.handlers.continueSession({
      sessionId: existingBinding.sessionId,
      prompt: text,
      provider: config.provider,
      model: config.model || undefined,
    });

    if (!continued) {
      this.clearBinding(chatId);
      await this.sendText(chatId, 'The linked session is no longer available. Send your message again to start a new one.');
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.restClient || !text.trim()) {
      return;
    }

    await this.restClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    this.updateStatus({ lastOutboundAt: Date.now() });
  }

  async handleSessionMessage(sessionId: string, message: StreamMessage): Promise<void> {
    const binding = this.bindings.find((item) => item.sessionId === sessionId);
    if (!binding) {
      return;
    }

    const text = extractAssistantText(message);
    if (!text) {
      return;
    }

    await this.sendText(binding.chatId, text);
  }

  async handleRunnerError(sessionId: string, errorMessage: string): Promise<void> {
    const binding = this.bindings.find((item) => item.sessionId === sessionId);
    if (!binding) {
      return;
    }
    await this.sendText(binding.chatId, `Runner error: ${errorMessage}`);
  }

  async handlePermissionRequest(payload: PermissionRequestPayload): Promise<void> {
    const binding = this.bindings.find((item) => item.sessionId === payload.sessionId);
    if (!binding) {
      return;
    }

    this.permissionIndex.set(payload.toolUseId, {
      chatId: binding.chatId,
      sessionId: payload.sessionId,
    });

    await this.sendText(binding.chatId, buildPermissionHelp(payload.toolName, payload.toolUseId));
  }
}

export const feishuBridge = new FeishuBridgeService();
