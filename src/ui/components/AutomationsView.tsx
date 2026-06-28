import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { toast } from 'sonner';
import {
  Calendar,
  CheckCircle2,
  Clock,
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow,
  X,
} from './icons';
import { SidebarHeaderTrigger } from './Sidebar';
import { useAppStore } from '../store/useAppStore';
import { useClaudeModelConfig } from '../hooks/useClaudeModelConfig';
import { useCodexModelConfig } from '../hooks/useCodexModelConfig';
import { useOpencodeModelConfig } from '../hooks/useOpencodeModelConfig';
import { useKimiModelConfig } from '../hooks/useKimiModelConfig';
import type {
  AgentProvider,
  AutomationDefinition,
  AutomationSchedule,
  AutomationSnapshot,
  UpsertAutomationInput,
} from '../types';

type AutomationFormState = {
  id?: string;
  name: string;
  projectCwd: string;
  prompt: string;
  provider: AgentProvider;
  model: string;
  scheduleKind: AutomationSchedule['kind'];
  timeOfDay: string;
  dayOfWeek: number;
  intervalMinutes: number;
  runAtLocal: string;
  enabled: boolean;
};

const PROVIDERS: Array<{ id: AgentProvider; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'grok', label: 'Grok' },
  { id: 'opencode', label: 'OpenCode' },
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TEMPLATES: Array<{
  title: string;
  description: string;
  prompt: string;
  schedule: Pick<AutomationFormState, 'scheduleKind' | 'timeOfDay' | 'dayOfWeek' | 'intervalMinutes'>;
}> = [
  {
    title: 'Daily project digest',
    description: 'Summarize changes, risks, and next actions in this project.',
    prompt:
      'Review the current project state and recent work. Summarize what changed, what looks risky, and the most useful next actions.',
    schedule: { scheduleKind: 'daily', timeOfDay: '09:00', dayOfWeek: 1, intervalMinutes: 60 },
  },
  {
    title: 'Weekly PR and issue report',
    description: 'Create a concise progress report for code review and planning.',
    prompt:
      'Review recent git activity, open work, and unresolved issues in this project. Produce a weekly report with decisions needed and concrete next steps.',
    schedule: { scheduleKind: 'weekly', timeOfDay: '10:00', dayOfWeek: 5, intervalMinutes: 60 },
  },
  {
    title: 'Dependency check',
    description: 'Look for dependency or build risks before they pile up.',
    prompt:
      'Inspect dependency, build, and runtime configuration for this project. Report outdated or risky items and suggest the smallest safe fixes.',
    schedule: { scheduleKind: 'weekly', timeOfDay: '11:00', dayOfWeek: 1, intervalMinutes: 60 },
  },
  {
    title: 'Release readiness',
    description: 'Run a pre-release review and identify blockers.',
    prompt:
      'Assess release readiness for this project. Check validation commands, dirty worktree state, changelog needs, and likely release blockers.',
    schedule: { scheduleKind: 'once', timeOfDay: '09:00', dayOfWeek: 1, intervalMinutes: 60 },
  },
];

function defaultRunAtLocal(): string {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setSeconds(0, 0);
  return toDatetimeLocalValue(next.getTime());
}

function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now() + 60 * 60 * 1000;
}

function createEmptyForm(projectCwd: string | null, model = ''): AutomationFormState {
  return {
    name: '',
    projectCwd: projectCwd || '',
    prompt: '',
    provider: 'claude',
    model,
    scheduleKind: 'daily',
    timeOfDay: '09:00',
    dayOfWeek: 1,
    intervalMinutes: 60,
    runAtLocal: defaultRunAtLocal(),
    enabled: true,
  };
}

function formFromAutomation(automation: AutomationDefinition): AutomationFormState {
  return {
    id: automation.id,
    name: automation.name,
    projectCwd: automation.projectCwd,
    prompt: automation.prompt,
    provider: automation.runtime.provider,
    model: automation.runtime.model || '',
    scheduleKind: automation.schedule.kind,
    timeOfDay: automation.schedule.timeOfDay || '09:00',
    dayOfWeek: automation.schedule.dayOfWeek ?? 1,
    intervalMinutes: automation.schedule.intervalMinutes || 60,
    runAtLocal: toDatetimeLocalValue(automation.schedule.runAt || Date.now() + 60 * 60 * 1000),
    enabled: automation.enabled,
  };
}

function scheduleFromForm(form: AutomationFormState): AutomationSchedule {
  if (form.scheduleKind === 'once') {
    return { kind: 'once', runAt: fromDatetimeLocalValue(form.runAtLocal) };
  }
  if (form.scheduleKind === 'weekly') {
    return { kind: 'weekly', dayOfWeek: form.dayOfWeek, timeOfDay: form.timeOfDay };
  }
  if (form.scheduleKind === 'interval') {
    return { kind: 'interval', intervalMinutes: form.intervalMinutes };
  }
  return { kind: 'daily', timeOfDay: form.timeOfDay };
}

function inputFromForm(form: AutomationFormState): UpsertAutomationInput {
  return {
    id: form.id,
    name: form.name,
    projectCwd: form.projectCwd,
    prompt: form.prompt,
    enabled: form.enabled,
    schedule: scheduleFromForm(form),
    runtime: {
      provider: form.provider,
      model: form.model.trim() || null,
    },
  };
}

function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'once') {
    return `Once at ${formatDateTime(schedule.runAt || null)}`;
  }
  if (schedule.kind === 'weekly') {
    return `Every ${DAY_LABELS[schedule.dayOfWeek ?? 1]} at ${schedule.timeOfDay || '09:00'}`;
  }
  if (schedule.kind === 'interval') {
    return `Every ${schedule.intervalMinutes || 60} min`;
  }
  return `Daily at ${schedule.timeOfDay || '09:00'}`;
}

function projectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function providerLabel(provider: AgentProvider): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label || provider;
}

export function AutomationsView() {
  const {
    sidebarCollapsed,
    projectCwd,
    setActiveWorkspace,
    setActiveSession,
    setShowNewSession,
  } = useAppStore();
  const claudeConfig = useClaudeModelConfig();
  const codexConfig = useCodexModelConfig();
  const opencodeConfig = useOpencodeModelConfig();
  const kimiConfig = useKimiModelConfig();
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<AutomationSnapshot>({ automations: [], recentRuns: [] });
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AutomationFormState>(() => createEmptyForm(projectCwd));
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await window.electron.getAutomations());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load automations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
    void window.electron.getRecentCwds(8).then(setRecentCwds).catch(() => undefined);
  }, [loadSnapshot]);

  useEffect(() => {
    return window.electron.onServerEvent((event) => {
      if (event.type === 'automation.changed') {
        setSnapshot(event.payload);
        setLoading(false);
      }
    });
  }, []);

  const modelOptions = useMemo(() => {
    const unique = (items: Array<string | null | undefined>) =>
      Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
    return {
      claude: unique([claudeConfig.defaultModel, ...claudeConfig.options]),
      codex: unique([
        codexConfig.defaultModel,
        ...codexConfig.availableModels.filter((model) => model.enabled).map((model) => model.name),
        ...codexConfig.options,
      ]),
      kimi: unique([
        kimiConfig.defaultModel,
        ...kimiConfig.availableModels.filter((model) => model.enabled).map((model) => model.name),
        ...kimiConfig.options,
      ]),
      opencode: unique([
        opencodeConfig.defaultModel,
        ...opencodeConfig.availableModels.filter((model) => model.enabled).map((model) => model.name),
        ...opencodeConfig.options,
      ]),
      grok: unique([]),
    } satisfies Record<AgentProvider, string[]>;
  }, [claudeConfig, codexConfig, kimiConfig, opencodeConfig]);

  const projectOptions = useMemo(
    () => Array.from(new Set([projectCwd, ...recentCwds].filter((cwd): cwd is string => Boolean(cwd)))),
    [projectCwd, recentCwds]
  );

  const openNewDialog = (template?: (typeof TEMPLATES)[number]) => {
    const defaultModel = modelOptions.claude[0] || '';
    setForm({
      ...createEmptyForm(projectCwd || projectOptions[0] || '', defaultModel),
      ...(template
        ? {
            name: template.title,
            prompt: template.prompt,
            scheduleKind: template.schedule.scheduleKind,
            timeOfDay: template.schedule.timeOfDay,
            dayOfWeek: template.schedule.dayOfWeek,
            intervalMinutes: template.schedule.intervalMinutes,
          }
        : {}),
    });
    setDialogOpen(true);
  };

  const openEditDialog = (automation: AutomationDefinition) => {
    setForm(formFromAutomation(automation));
    setDialogOpen(true);
  };

  const updateProvider = (provider: AgentProvider) => {
    const options = modelOptions[provider] || [];
    setForm((current) => ({
      ...current,
      provider,
      model: options.includes(current.model) ? current.model : options[0] || '',
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.electron.saveAutomation(inputFromForm(form));
      setDialogOpen(false);
      toast.success(form.id ? 'Automation updated.' : 'Automation added.');
      await loadSnapshot();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save automation.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (automation: AutomationDefinition) => {
    try {
      await window.electron.setAutomationEnabled(automation.id, !automation.enabled);
      await loadSnapshot();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update automation.');
    }
  };

  const handleRunNow = async (automation: AutomationDefinition) => {
    setRunningId(automation.id);
    try {
      const result = await window.electron.runAutomationNow(automation.id);
      if (!result.ok || !result.sessionId) {
        toast.error(result.message || 'Automation did not start.');
        return;
      }
      toast.success('Automation started.');
      setActiveWorkspace('chat');
      setActiveSession(result.sessionId);
      setShowNewSession(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to run automation.');
    } finally {
      setRunningId(null);
    }
  };

  const handleDelete = async (automation: AutomationDefinition) => {
    if (!window.confirm(`Delete "${automation.name}"?`)) return;
    try {
      await window.electron.deleteAutomation(automation.id);
      await loadSnapshot();
      toast.success('Automation deleted.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete automation.');
    }
  };

  const openRunSession = (sessionId: string | null) => {
    if (!sessionId) return;
    setActiveWorkspace('chat');
    setActiveSession(sessionId);
    setShowNewSession(false);
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)]">
      <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0 bg-[var(--bg-primary)]`}>
        <div className="flex h-full items-center px-3">
          {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
        </div>
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-7 px-8 pb-7 pt-4">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[24px] font-semibold tracking-normal text-[var(--text-primary)]">
                Automations
              </h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[var(--text-secondary)]">
                Schedule prompts to run in a selected project with a specific agent runtime. Each run creates a normal project session.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openNewDialog()}
              className="no-drag inline-flex h-9 items-center gap-2 rounded-md bg-[var(--text-primary)] px-3 text-[13px] font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </header>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Start from a template</h2>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {TEMPLATES.map((template) => (
                <button
                  key={template.title}
                  type="button"
                  onClick={() => openNewDialog(template)}
                  className="group flex min-h-[104px] flex-col justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--sidebar-item-hover)]"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-secondary)]">
                      <Calendar className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{template.title}</div>
                      <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-secondary)]">
                        {template.description}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Scheduled tasks</h2>
              <button
                type="button"
                onClick={() => void loadSnapshot()}
                className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Refresh
              </button>
            </div>

            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
              {loading ? (
                <div className="flex h-36 items-center justify-center text-[13px] text-[var(--text-secondary)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading automations
                </div>
              ) : snapshot.automations.length === 0 ? (
                <div className="flex min-h-[180px] flex-col items-center justify-center px-6 text-center">
                  <Workflow className="h-8 w-8 text-[var(--text-muted)]" />
                  <div className="mt-3 text-[14px] font-semibold text-[var(--text-primary)]">No automations yet</div>
                  <div className="mt-1 max-w-md text-[13px] leading-5 text-[var(--text-secondary)]">
                    Add a scheduled task to run a prompt in one of your project workspaces.
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {snapshot.automations.map((automation) => (
                    <div key={automation.id} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(180px,0.7fr)_minmax(160px,0.55fr)_auto] lg:items-center">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              automation.enabled ? 'bg-emerald-500' : 'bg-[var(--text-muted)]'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => openEditDialog(automation)}
                            className="truncate text-left text-[13px] font-semibold text-[var(--text-primary)] hover:underline"
                          >
                            {automation.name}
                          </button>
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-secondary)]">
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{projectName(automation.projectCwd)}</span>
                          </span>
                          <span>{providerLabel(automation.runtime.provider)}</span>
                          {automation.runtime.model ? <span className="truncate">{automation.runtime.model}</span> : null}
                        </div>
                      </div>

                      <div className="text-[12px] text-[var(--text-secondary)]">
                        <div className="inline-flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          {formatSchedule(automation.schedule)}
                        </div>
                        <div className="mt-1 text-[var(--text-muted)]">Next: {formatDateTime(automation.nextRunAt)}</div>
                      </div>

                      <button
                        type="button"
                        onClick={() => openRunSession(automation.lastRunSessionId)}
                        disabled={!automation.lastRunSessionId}
                        className="text-left text-[12px] text-[var(--text-secondary)] disabled:cursor-default disabled:opacity-60"
                      >
                        <div className="inline-flex items-center gap-1.5">
                          {automation.lastRunStatus === 'completed' ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          ) : automation.lastRunStatus === 'failed' ? (
                            <X className="h-3.5 w-3.5 text-red-500" />
                          ) : (
                            <Clock className="h-3.5 w-3.5" />
                          )}
                          {automation.lastRunStatus || 'Never run'}
                        </div>
                        <div className="mt-1 text-[var(--text-muted)]">
                          Runs {automation.runCount} · Failures {automation.failureCount}
                        </div>
                      </button>

                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => void handleRunNow(automation)}
                          disabled={runningId === automation.id}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
                          title="Run now"
                          aria-label="Run now"
                        >
                          {runningId === automation.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggle(automation)}
                          className="inline-flex h-8 min-w-[68px] items-center justify-center rounded-md border border-[var(--border)] px-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                        >
                          {automation.enabled ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditDialog(automation)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                          title="Edit"
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(automation)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-red-500"
                          title="Delete"
                          aria-label="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <AutomationDialog
        open={dialogOpen}
        form={form}
        modelOptions={modelOptions[form.provider] || []}
        projectOptions={projectOptions}
        saving={saving}
        onOpenChange={setDialogOpen}
        onFormChange={setForm}
        onProviderChange={updateProvider}
        onSave={handleSave}
      />
    </div>
  );
}

function AutomationDialog({
  open,
  form,
  modelOptions,
  projectOptions,
  saving,
  onOpenChange,
  onFormChange,
  onProviderChange,
  onSave,
}: {
  open: boolean;
  form: AutomationFormState;
  modelOptions: string[];
  projectOptions: string[];
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onFormChange: (form: AutomationFormState | ((current: AutomationFormState) => AutomationFormState)) => void;
  onProviderChange: (provider: AgentProvider) => void;
  onSave: () => void;
}) {
  const setField = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) => {
    onFormChange((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(720px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-2xl">
          <div className="flex items-start justify-between border-b border-[var(--border)] px-6 py-5">
            <div>
              <Dialog.Title className="text-[18px] font-semibold text-[var(--text-primary)]">
                {form.id ? 'Edit automation' : 'Add automation'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-[var(--text-secondary)]">
                Runs create normal sessions in the selected project and automatically approve runtime prompts.
              </Dialog.Description>
            </div>
            <Dialog.Close className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <Field label="Name">
              <input
                value={form.name}
                onChange={(event) => setField('name', event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                placeholder="Daily project digest"
              />
            </Field>

            <Field label="Project">
              <div className="flex gap-2">
                <select
                  value={form.projectCwd}
                  onChange={(event) => setField('projectCwd', event.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                >
                  {form.projectCwd && !projectOptions.includes(form.projectCwd) ? (
                    <option value={form.projectCwd}>{form.projectCwd}</option>
                  ) : null}
                  {projectOptions.map((cwd) => (
                    <option key={cwd} value={cwd}>
                      {projectName(cwd)} · {cwd}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={async () => {
                    const selected = await window.electron.selectDirectory();
                    if (selected) setField('projectCwd', selected);
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--border)] px-3 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                >
                  <FolderOpen className="h-4 w-4" />
                  Browse
                </button>
              </div>
            </Field>

            <Field label="Prompt">
              <textarea
                value={form.prompt}
                onChange={(event) => setField('prompt', event.target.value)}
                className="min-h-[168px] w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[13px] leading-5 text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                placeholder="Describe the recurring work this agent should perform..."
              />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Agent Runtime">
                <select
                  value={form.provider}
                  onChange={(event) => onProviderChange(event.target.value as AgentProvider)}
                  className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Model">
                {modelOptions.length > 0 ? (
                  <select
                    value={form.model}
                    onChange={(event) => setField('model', event.target.value)}
                    className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  >
                    {!form.model ? <option value="">Default</option> : null}
                    {modelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={form.model}
                    onChange={(event) => setField('model', event.target.value)}
                    className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    placeholder="Default"
                  />
                )}
              </Field>
            </div>

            <Field label="Schedule">
              <div className="flex flex-wrap gap-2">
                {(['daily', 'weekly', 'interval', 'once'] as AutomationSchedule['kind'][]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setField('scheduleKind', kind)}
                    className={`h-8 rounded-md border px-3 text-[12px] capitalize ${
                      form.scheduleKind === kind
                        ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--bg-primary)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {kind}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {form.scheduleKind === 'weekly' ? (
                  <select
                    value={form.dayOfWeek}
                    onChange={(event) => setField('dayOfWeek', Number(event.target.value))}
                    className="h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  >
                    {DAY_LABELS.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : null}

                {form.scheduleKind === 'daily' || form.scheduleKind === 'weekly' ? (
                  <input
                    type="time"
                    value={form.timeOfDay}
                    onChange={(event) => setField('timeOfDay', event.target.value)}
                    className="h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  />
                ) : null}

                {form.scheduleKind === 'interval' ? (
                  <label className="inline-flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                    Every
                    <input
                      type="number"
                      min={1}
                      value={form.intervalMinutes}
                      onChange={(event) => setField('intervalMinutes', Math.max(1, Number(event.target.value)))}
                      className="h-9 w-24 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                    />
                    minutes
                  </label>
                ) : null}

                {form.scheduleKind === 'once' ? (
                  <input
                    type="datetime-local"
                    value={form.runAtLocal}
                    onChange={(event) => setField('runAtLocal', event.target.value)}
                    className="h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)]"
                  />
                ) : null}
              </div>
            </Field>

            <label className="inline-flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setField('enabled', event.target.checked)}
                className="h-4 w-4 accent-[var(--text-primary)]"
              />
              Enable after saving
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--border)] px-6 py-4">
            <Dialog.Close className="h-9 rounded-md border border-[var(--border)] px-4 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="inline-flex h-9 min-w-[88px] items-center justify-center rounded-md bg-[var(--text-primary)] px-4 text-[13px] font-medium text-[var(--bg-primary)] disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : form.id ? 'Save' : 'Add'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
    </div>
  );
}
