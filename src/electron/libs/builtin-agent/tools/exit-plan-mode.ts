import type { BuiltinPlanController, BuiltinToolRegistryEntry } from '../types';
import { asString } from './common';

export function createExitPlanModeTool(plan: BuiltinPlanController): BuiltinToolRegistryEntry {
  return {
    name: 'exit_plan_mode',
    readOnly: true,
    description: 'When read-only plan mode is active, present a concrete implementation plan and ask the user to approve execution.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Concrete step-by-step plan to present for approval.' },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    async execute(args) {
      if (plan.getMode() !== 'plan') {
        return { content: 'Error: exit_plan_mode is only valid while read-only plan mode is active.', isError: true, status: 'command_error' };
      }
      const planText = asString(args.plan).trim();
      if (!planText) return { content: 'Error: plan is required', isError: true, status: 'command_error' };
      const decision = await plan.approvePlan(planText);
      if (decision.behavior !== 'allow') {
        return { content: decision.message || 'User rejected the plan. Stay in read-only mode and revise the approach.', status: 'blocked' };
      }
      plan.setMode('default');
      return {
        content: `User approved the plan. Permission mode switched to default; you may now execute the approved plan.\n\nApproved plan:\n${planText}`,
        status: 'success',
      };
    },
  };
}

