import type { BrowserWindow } from 'electron';
import * as sessions from './session-store';
import { DEFAULT_WORKSPACE_CHANNEL_ID, type AutomationDefinition, type SessionStartPayload } from '../../shared/types';

type AutomationSessionStarter = (payload: SessionStartPayload) => Promise<string | null>;
type AutomationChangeEmitter = () => void;

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_DUE_PER_TICK = 4;

function formatRunTitle(automation: AutomationDefinition, now = Date.now()): string {
  const timestamp = new Date(now)
    .toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(',', '');
  return `[Automation] ${automation.name} - ${timestamp}`;
}

function buildAutomationSessionPayload(
  automation: AutomationDefinition,
  runId: string
): SessionStartPayload {
  const provider = automation.runtime.provider;
  return {
    title: formatRunTitle(automation),
    prompt: automation.prompt,
    cwd: automation.projectCwd,
    projectCwd: automation.projectCwd,
    provider,
    model: automation.runtime.model || undefined,
    compatibleProviderId:
      provider === 'claude' ? automation.runtime.compatibleProviderId || undefined : undefined,
    claudeAccessMode: provider === 'claude' ? 'fullAccess' : undefined,
    claudeExecutionMode: provider === 'claude' ? 'execute' : undefined,
    codexExecutionMode: provider === 'codex' ? 'execute' : undefined,
    codexPermissionMode: provider === 'codex' ? 'fullAccess' : undefined,
    codexReasoningEffort:
      provider === 'codex' ? automation.runtime.codexReasoningEffort || undefined : undefined,
    codexFastMode: provider === 'codex' ? automation.runtime.codexFastMode === true : undefined,
    kimiPermissionMode: provider === 'kimi' ? 'yolo' : undefined,
    opencodePermissionMode: provider === 'opencode' ? 'fullAccess' : undefined,
    aegisPermissionMode: provider === 'aegis' ? 'fullAccess' : undefined,
    aegisReasoningEffort:
      provider === 'aegis' ? automation.runtime.aegisReasoningEffort || undefined : undefined,
    teamMode: provider === 'aegis' ? automation.runtime.teamMode : undefined,
    teamId: provider === 'aegis' ? automation.runtime.teamId || null : undefined,
    hiddenFromThreads: false,
    channelId: DEFAULT_WORKSPACE_CHANNEL_ID,
    automationRunId: runId,
    skipTitleGeneration: true,
  };
}

export class AutomationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningAutomationIds = new Set<string>();

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly startSession: AutomationSessionStarter,
    private readonly emitChanged: AutomationChangeEmitter,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runningAutomationIds.clear();
  }

  async runNow(automationId: string): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
    const automation = sessions.getAutomation(automationId);
    if (!automation) {
      return { ok: false, message: 'Automation was not found.' };
    }
    return this.startAutomationRun(automation);
  }

  private async tick(): Promise<void> {
    if (this.mainWindow.isDestroyed() || this.mainWindow.webContents.isDestroyed()) {
      return;
    }
    const due = sessions.listDueAutomations(Date.now(), MAX_DUE_PER_TICK);
    for (const automation of due) {
      if (this.runningAutomationIds.has(automation.id)) {
        continue;
      }
      void this.startAutomationRun(automation);
    }
  }

  private async startAutomationRun(
    automation: AutomationDefinition
  ): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
    if (this.runningAutomationIds.has(automation.id)) {
      return { ok: false, message: 'Automation is already running.' };
    }
    if (sessions.hasRunningAutomationRun(automation.id)) {
      return { ok: false, message: 'Automation is already running.' };
    }
    this.runningAutomationIds.add(automation.id);
    const run = sessions.createAutomationRun(automation.id);
    this.emitChanged();

    try {
      const sessionId = await this.startSession(buildAutomationSessionPayload(automation, run.id));
      if (!sessionId) {
        sessions.finishAutomationRun(run.id, 'failed', 'Automation session did not start.');
        this.emitChanged();
        return { ok: false, message: 'Automation session did not start.' };
      }
      sessions.setAutomationRunSession(run.id, sessionId);
      this.emitChanged();
      return { ok: true, sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessions.finishAutomationRun(run.id, 'failed', message);
      this.emitChanged();
      return { ok: false, message };
    } finally {
      this.runningAutomationIds.delete(automation.id);
    }
  }
}
