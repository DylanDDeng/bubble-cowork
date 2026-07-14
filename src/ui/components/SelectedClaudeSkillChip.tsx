import { Plug, SkillStack, X } from './icons';
import type { ClaudeSkillSummary } from '../types';

function formatSkillChipLabel(skill: ClaudeSkillSummary): string {
  const preferred = skill.title?.trim() || skill.name;
  return preferred
    .replace(/^[/$]/, '')
    .replace(/^plugin:/i, '')
    .trim();
}

export function SelectedClaudeSkillChip({
  skill,
  onClear,
  compact = false,
}: {
  skill: ClaudeSkillSummary;
  onClear?: () => void;
  compact?: boolean;
}) {
  const label = formatSkillChipLabel(skill) || skill.name.replace(/^[/$]/, '');
  const Icon = skill.source === 'plugin' ? Plug : SkillStack;

  return (
    <div
      className={`composer-inline-chip composer-inline-chip--skill composer-inline-chip--message ${
        compact ? '' : 'composer-inline-chip--large'
      }`}
      title={skill.title ? `${skill.title} (${skill.name})` : skill.name}
    >
      <span className="composer-inline-chip__icon" aria-hidden="true">
        <Icon />
      </span>

      <span className="composer-inline-chip__label max-w-[180px]">
        {label}
      </span>

      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="composer-inline-chip__clear"
          aria-label="Remove selected skill"
          title="Remove skill"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
