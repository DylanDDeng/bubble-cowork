import { create } from 'zustand';
import type { WorkflowAction, WorkflowActionResult, WorkflowRunView } from '../../shared/workflow';
import { CURRENT_SESSION_AGENT } from '../../shared/workflow';

type WorkflowState = {
  runs: Record<string, WorkflowRunView>;
  loaded: boolean;
  load: () => Promise<void>;
  upsert: (view: WorkflowRunView) => void;
  act: (action: WorkflowAction) => Promise<WorkflowActionResult>;
};

let loading: Promise<void> | null = null;

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runs: {},
  loaded: false,

  load: () => {
    loading ??= window.electron.workflows
      .list()
      .then((views) =>
        set((state) => ({
          loaded: true,
          runs: { ...Object.fromEntries(views.map((v) => [v.id, v])), ...state.runs },
        })),
      )
      .catch(() => {
        loading = null;
      });
    return loading;
  },

  upsert: (view) =>
    set((state) => {
      const current = state.runs[view.id];
      // Updates can race; never replace a newer revision with an older one.
      if (current && current.revision > view.revision) return state;
      return { runs: { ...state.runs, [view.id]: view } };
    }),

  act: async (action) => {
    const result = await window.electron.workflows.act(action);
    if (result.run) get().upsert(result.run);
    return result;
  },
}));

/** The run a chat session started with this start_workflow tool call. */
export function findRunForToolUse(
  runs: Record<string, WorkflowRunView>,
  toolUseId: string,
  resultRunId: string | null,
): WorkflowRunView | null {
  if (resultRunId && runs[resultRunId]) return runs[resultRunId];
  return Object.values(runs).find((run) => run.parent?.toolUseId === toolUseId) ?? null;
}

/** Tab label for a member (or planner) session: "<agent> · <role>". */
export function workflowSessionLabel(runs: Record<string, WorkflowRunView>, sessionId: string): string {
  for (const run of Object.values(runs)) {
    if (run.plannerSessionId === sessionId) return 'Workflow planner';
    const member = run.members.find((m) => m.currentSessionId === sessionId && m.agent !== CURRENT_SESSION_AGENT);
    if (member) return `${member.agent} · ${member.focus ?? member.role}`;
  }
  return 'Workflow member';
}
