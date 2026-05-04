export { createBashTool } from './bash';
export { createEditTool } from './edit';
export { createExitPlanModeTool } from './exit-plan-mode';
export { createGlobTool } from './glob';
export { createGrepTool } from './grep';
export { createLspTool } from './lsp';
export { createMemoryReadSummaryTool, createMemorySearchTool } from './memory';
export { createQuestionTool } from './question';
export { createReadTool } from './read';
export { createSkillReadResourceTool, createSkillReadTool, createSkillTool } from './skill';
export { createTaskTool } from './task';
export { createTodoTool } from './todo';
export { createToolSearchTool } from './tool-search';
export { createWebFetchTool } from './web-fetch';
export { createWebSearchTool } from './web-search';
export { createWriteTool } from './write';

import type { ChildProcess } from 'child_process';
import type {
  BuiltinApprovalController,
  BuiltinLspAdapter,
  BuiltinMemoryAdapter,
  BuiltinPlanController,
  BuiltinQuestionController,
  BuiltinSkillAdapter,
  BuiltinTodoStore,
  BuiltinToolRegistryEntry,
  BuiltinToolSearchController,
} from '../types';
import { createBashTool } from './bash';
import { createEditTool } from './edit';
import { createExitPlanModeTool } from './exit-plan-mode';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createLspTool } from './lsp';
import { createMemoryReadSummaryTool, createMemorySearchTool } from './memory';
import { createQuestionTool } from './question';
import { createReadTool } from './read';
import { createSkillReadResourceTool, createSkillReadTool, createSkillTool } from './skill';
import { createTaskTool } from './task';
import { createTodoTool } from './todo';
import { createToolSearchTool } from './tool-search';
import { createWebFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';
import { createWriteTool } from './write';

export interface CreateAllBuiltinToolsOptions {
  children: Set<ChildProcess>;
  approvalController?: BuiltinApprovalController;
  memoryAdapter: BuiltinMemoryAdapter;
  todoStore: BuiltinTodoStore;
  planController: BuiltinPlanController;
  questionController: BuiltinQuestionController;
  toolSearchController: BuiltinToolSearchController;
  lspAdapter?: BuiltinLspAdapter;
  skillAdapter?: BuiltinSkillAdapter;
}

export function createAllTools(cwd: string, options: CreateAllBuiltinToolsOptions): BuiltinToolRegistryEntry[] {
  const skillTool = createSkillTool(options.skillAdapter);
  skillTool.deferred = true;
  const skillReadTool = createSkillReadTool(options.skillAdapter);
  const skillReadResourceTool = createSkillReadResourceTool(options.skillAdapter);

  return [
    createReadTool(cwd),
    createBashTool(cwd, options.approvalController, options.children),
    createWriteTool(cwd, options.approvalController),
    createEditTool(cwd, options.approvalController),
    createGlobTool(cwd),
    createGrepTool(cwd),
    createLspTool(cwd, options.lspAdapter),
    createWebSearchTool(),
    createWebFetchTool(),
    createMemorySearchTool(options.memoryAdapter),
    createMemoryReadSummaryTool(options.memoryAdapter),
    createTaskTool(),
    createQuestionTool(options.questionController),
    createTodoTool(options.todoStore),
    createExitPlanModeTool(options.planController),
    createToolSearchTool(options.toolSearchController),
    skillReadTool,
    skillReadResourceTool,
    skillTool,
  ];
}
