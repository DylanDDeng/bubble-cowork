import type { BuiltinQuestionController, BuiltinToolRegistryEntry } from '../types';
import { asString } from './common';

export function createQuestionTool(controller: BuiltinQuestionController): BuiltinToolRegistryEntry {
  return {
    name: 'question',
    readOnly: true,
    description: [
      'Ask the user one to three structured questions during execution.',
      'Use only for targeted questions that unblock real work; do not ask whether to proceed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'One to three questions.',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Very short label for this question.' },
              question: { type: 'string', description: 'Complete user-facing question.' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['header', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async execute(args) {
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
      if (rawQuestions.length === 0 || rawQuestions.length > 3) {
        return { content: 'Error: ask one to three questions.', isError: true, status: 'command_error' };
      }
      const questions = rawQuestions.map((item) => {
        const q = item as Record<string, unknown>;
        const options = Array.isArray(q.options)
          ? q.options
              .map((option) => {
                const record = option as Record<string, unknown>;
                const label = asString(record.label).trim();
                return label
                  ? { label, ...(asString(record.description).trim() ? { description: asString(record.description).trim() } : {}) }
                  : null;
              })
              .filter((option): option is { label: string; description?: string } => Boolean(option))
          : [];
        return {
          header: asString(q.header).trim(),
          question: asString(q.question).trim(),
          options,
          multiSelect: q.multiSelect === true || undefined,
        };
      });
      for (const [index, question] of questions.entries()) {
        if (!question.header || !question.question || question.options.length === 0) {
          return { content: `Error: question ${index} requires header, question, and options.`, isError: true, status: 'command_error' };
        }
      }
      const decision = await controller.ask({ questions });
      if (decision.behavior !== 'allow') {
        return { content: decision.message || 'User did not answer the question.', isError: true, status: 'blocked' };
      }
      return { content: JSON.stringify(decision.updatedInput || {}, null, 2), status: 'success', metadata: { kind: 'question' } };
    },
  };
}

