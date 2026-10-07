import { ipcMainHandle } from '../util';
import type { WorkflowAction, WorkflowStartRequest } from '../../shared/workflow';
import type { WorkflowService } from '../libs/workflow/workflow-service';

/** Typed IPC for app-level workflows; run updates are pushed as `workflow.updated` server events. */
export function setupWorkflowIPC(service: WorkflowService): void {
  ipcMainHandle('workflow-start', (_event, request: WorkflowStartRequest) => service.start(request));
  ipcMainHandle('workflow-action', (_event, action: WorkflowAction) => service.act(action));
  ipcMainHandle('workflow-list', () => service.list());
  ipcMainHandle('workflow-get', (_event, runId: string) => service.get(runId));
  // Composer permission preferences live in renderer storage; workflows started
  // from a chat use the latest ones for any new implementer session.
  ipcMainHandle('workflow-set-defaults', (_event, defaults: { permissionModes: Record<string, string> }) => {
    service.setDefaults(defaults);
  });
}
