// Kimi 2.x questions (`event.question.requested`) in Aegis's AskUserQuestion
// card and back. Kimi sends up to four items, each with 2–4 options and
// optional multi-select and free text; it takes answers keyed by item id:
//   single {option_id} | multi {option_ids} | other {text}
//   | multi_with_other {option_ids, other_text} | skipped

import type { AskUserQuestionInput } from '../../../shared/types';

export interface KimiQuestionItem {
  id: string;
  question: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect: boolean;
  allowOther: boolean;
}

export type KimiQuestionAnswer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The items of a question request; empty when the payload carries none. */
export function kimiQuestionItems(payload: Record<string, unknown>): KimiQuestionItem[] {
  const raw = Array.isArray(payload.questions) ? payload.questions : [];
  return raw.flatMap((item): KimiQuestionItem[] => {
    if (!isRecord(item) || !text(item.id) || !text(item.question)) return [];
    const options = (Array.isArray(item.options) ? item.options : []).flatMap((option) =>
      isRecord(option) && text(option.id) && text(option.label)
        ? [{ id: text(option.id), label: text(option.label), ...(text(option.description) ? { description: text(option.description) } : {}) }]
        : []
    );
    return [
      {
        id: text(item.id),
        question: text(item.question),
        ...(text(item.header) ? { header: text(item.header) } : {}),
        options,
        multiSelect: item.multi_select === true,
        allowOther: item.allow_other === true,
      },
    ];
  });
}

/** The AskUserQuestion card for the items. */
export function kimiQuestionInput(items: KimiQuestionItem[]): AskUserQuestionInput {
  return {
    questions: items.map((item) => ({
      question: item.question,
      ...(item.header ? { header: item.header } : {}),
      options: item.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
      ...(item.multiSelect ? { multiSelect: true } : {}),
    })),
  };
}

/**
 * The card's answers (keyed by question text; choices and free text joined
 * with commas) as Kimi answers keyed by item id. Text that matches no option
 * becomes free text when the item allows it and is dropped otherwise.
 */
export function kimiQuestionAnswers(
  items: KimiQuestionItem[],
  answers: Record<string, unknown>
): Record<string, KimiQuestionAnswer> {
  const out: Record<string, KimiQuestionAnswer> = {};
  for (const item of items) {
    const parts = text(answers[item.question]).split(',').map((part) => part.trim()).filter(Boolean);
    const optionIds: string[] = [];
    const other: string[] = [];
    for (const part of parts) {
      const option = item.options.find((candidate) => candidate.label.toLowerCase() === part.toLowerCase());
      if (option && !optionIds.includes(option.id)) optionIds.push(option.id);
      else if (!option) other.push(part);
    }
    const otherText = item.allowOther ? other.join(', ') : '';
    if (!item.multiSelect) {
      out[item.id] = optionIds.length
        ? { kind: 'single', option_id: optionIds[0] }
        : otherText
          ? { kind: 'other', text: otherText }
          : { kind: 'skipped' };
    } else if (otherText) {
      out[item.id] = { kind: 'multi_with_other', option_ids: optionIds, other_text: otherText };
    } else {
      out[item.id] = optionIds.length ? { kind: 'multi', option_ids: optionIds } : { kind: 'skipped' };
    }
  }
  return out;
}
