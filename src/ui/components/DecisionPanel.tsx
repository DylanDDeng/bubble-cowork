import { useState } from 'react';
import { Check } from 'lucide-react';
import type { AskUserQuestionInput, AskUserQuestion, PermissionResult } from '../types';

interface DecisionPanelProps {
  input: AskUserQuestionInput;
  onSubmit: (result: PermissionResult) => void;
}

export function DecisionPanel({ input, onSubmit }: DecisionPanelProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({});

  const handleOptionSelect = (question: AskUserQuestion, label: string) => {
    const key = question.question;

    if (question.multiSelect) {
      // 多选：切换选项
      const current = answers[key] || '';
      const selected = current.split(',').filter(Boolean);
      const idx = selected.indexOf(label);

      if (idx === -1) {
        selected.push(label);
      } else {
        selected.splice(idx, 1);
      }

      setAnswers({ ...answers, [key]: selected.join(',') });
    } else {
      // 单选
      setAnswers({ ...answers, [key]: label });
    }
  };

  const handleOtherInput = (question: AskUserQuestion, value: string) => {
    const key = question.question;
    setOtherInputs({ ...otherInputs, [key]: value });
  };

  const handleSubmit = () => {
    // 合并选项答案和 "Other" 输入
    const finalAnswers: Record<string, string> = { ...answers };

    for (const [key, value] of Object.entries(otherInputs)) {
      if (value.trim()) {
        const existing = finalAnswers[key];
        if (existing) {
          finalAnswers[key] = `${existing},${value.trim()}`;
        } else {
          finalAnswers[key] = value.trim();
        }
      }
    }

    onSubmit({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: finalAnswers,
      },
    });
  };

  const handleCancel = () => {
    onSubmit({
      behavior: 'deny',
      message: 'User cancelled the request',
    });
  };

  const isOptionSelected = (question: AskUserQuestion, label: string): boolean => {
    const key = question.question;
    const current = answers[key] || '';

    if (question.multiSelect) {
      return current.split(',').includes(label);
    }
    return current === label;
  };

  const hasAnswer = input.questions.every((q) => {
    const key = q.question;
    return answers[key] || otherInputs[key]?.trim();
  });

  return (
    <div className="bg-[var(--bg-tertiary)] rounded-lg p-4 my-3 border border-[var(--accent)]/30">
      {input.questions.map((question, idx) => (
        <div key={idx} className={idx > 0 ? 'mt-4 pt-4 border-t border-[var(--border)]' : ''}>
          {/* Header */}
          {question.header && (
            <div className="text-xs text-[var(--accent)] mb-1">{question.header}</div>
          )}

          {/* Question */}
          <div className="font-medium mb-3">{question.question}</div>

          {/* Options */}
          {question.options && question.options.length > 0 && (
            <div className="space-y-2 mb-3">
              {question.options.map((option, optIdx) => (
                <button
                  key={optIdx}
                  onClick={() => handleOptionSelect(question, option.label)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    isOptionSelected(question, option.label)
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] hover:border-[var(--text-muted)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {question.multiSelect ? (
                      <div
                        className={`w-4 h-4 rounded border flex items-center justify-center ${
                          isOptionSelected(question, option.label)
                            ? 'border-[var(--accent)] bg-[var(--accent)]'
                            : 'border-[var(--text-muted)]'
                        }`}
                      >
                        {isOptionSelected(question, option.label) && (
                          <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                        )}
                      </div>
                    ) : (
                      <div
                        className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                          isOptionSelected(question, option.label)
                            ? 'border-[var(--accent)]'
                            : 'border-[var(--text-muted)]'
                        }`}
                      >
                        {isOptionSelected(question, option.label) && (
                          <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                        )}
                      </div>
                    )}
                    <span className="font-medium text-sm">{option.label}</span>
                  </div>
                  {option.description && (
                    <div className="text-xs text-[var(--text-secondary)] mt-1 ml-6">
                      {option.description}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Other input */}
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">
              Other (custom input):
            </div>
            <input
              type="text"
              value={otherInputs[question.question] || ''}
              onChange={(e) => handleOtherInput(question, e.target.value)}
              placeholder="Type your answer..."
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>
      ))}

      {/* Actions */}
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-[var(--border)]">
        <button
          onClick={handleCancel}
          className="px-4 py-2 rounded-lg text-sm hover:bg-[var(--border)] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!hasAnswer}
          className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Submit
        </button>
      </div>
    </div>
  );
}


// 生成问题签名（用于匹配 permission.request 和 tool_use）
export function getAskUserQuestionSignature(input: AskUserQuestionInput): string {
  return input.questions
    .map((q) => {
      const optionsStr = q.options
        ?.map((o) => `${o.label}|${o.description || ''}`)
        .join(';');
      return `${q.question}:${q.header || ''}:${q.multiSelect || false}:${optionsStr || ''}`;
    })
    .join('||');
}
