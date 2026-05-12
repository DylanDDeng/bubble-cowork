import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from './icons';
import notionAvatar01 from '../assets/agent-avatars/notion-avatar-01.svg';
import notionAvatar02 from '../assets/agent-avatars/notion-avatar-02.svg';
import notionAvatar03 from '../assets/agent-avatars/notion-avatar-03.svg';
import notionAvatar04 from '../assets/agent-avatars/notion-avatar-04.svg';
import notionAvatar05 from '../assets/agent-avatars/notion-avatar-05.svg';
import animeAvatar01 from '../assets/agent-avatars/anime-avatar-01.svg';
import type {
  AgentAvatarAssetKey,
  AgentProfile,
  AgentProfileAvatar,
} from '../types';

export const AGENT_AVATAR_OPTIONS: Array<{
  key: AgentAvatarAssetKey;
  label: string;
}> = [
  { key: 'notion-avatar-01', label: 'Avatar 1' },
  { key: 'notion-avatar-02', label: 'Avatar 2' },
  { key: 'notion-avatar-03', label: 'Avatar 3' },
  { key: 'notion-avatar-04', label: 'Avatar 4' },
  { key: 'notion-avatar-05', label: 'Avatar 5' },
  { key: 'anime-avatar-01', label: 'Anime Avatar 1' },
];

const AGENT_AVATAR_ASSETS: Record<AgentAvatarAssetKey, string> = {
  'notion-avatar-01': notionAvatar01,
  'notion-avatar-02': notionAvatar02,
  'notion-avatar-03': notionAvatar03,
  'notion-avatar-04': notionAvatar04,
  'notion-avatar-05': notionAvatar05,
  'anime-avatar-01': animeAvatar01,
};

const AGENT_AVATAR_SIZE_CLASSES = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
  lg: 'h-10 w-10',
  xl: 'h-14 w-14',
} as const;

type AgentAvatarSize = keyof typeof AGENT_AVATAR_SIZE_CLASSES;

export function AgentAvatar({
  profile,
  avatar,
  avatarKey,
  label,
  size = 'md',
  decorative = false,
  className = '',
}: {
  profile?: AgentProfile;
  avatar?: AgentProfileAvatar;
  avatarKey?: AgentAvatarAssetKey;
  label?: string;
  size?: AgentAvatarSize;
  decorative?: boolean;
  className?: string;
}) {
  const resolvedAvatarKey = avatarKey || avatar?.key || profile?.avatar.key || 'notion-avatar-04';
  const resolvedLabel = label || profile?.name || 'Agent avatar';
  const src = AGENT_AVATAR_ASSETS[resolvedAvatarKey] || notionAvatar04;
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [src]);

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : resolvedLabel}
      className={`inline-flex flex-shrink-0 items-center justify-center overflow-hidden ${AGENT_AVATAR_SIZE_CLASSES[size]} ${className}`}
    >
      <img
        src={imageFailed ? notionAvatar04 : src}
        alt=""
        className="h-full w-full object-cover"
        draggable={false}
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}

export function AvatarDropdown({
  value,
  onChange,
  label,
  triggerClassName = '',
  menuPlacement = 'bottom',
}: {
  value: AgentAvatarAssetKey;
  onChange: (key: AgentAvatarAssetKey) => void;
  label?: string;
  triggerClassName?: string;
  menuPlacement?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const current =
    AGENT_AVATAR_OPTIONS.find((option) => option.key === value) || AGENT_AVATAR_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handle);
    return () => window.removeEventListener('mousedown', handle);
  }, [open]);

  const menuPositionClass = menuPlacement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1';

  return (
    <div ref={containerRef} className={`relative no-drag ${triggerClassName}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-secondary)] focus:border-[var(--text-muted)] focus:outline-none"
      >
        <span className="flex min-w-0 items-center gap-2">
          <AgentAvatar avatarKey={current.key} size="md" decorative />
          <span className="truncate">{label || current.label}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)] transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={`popover-surface absolute left-0 z-20 max-h-64 w-full min-w-[180px] overflow-y-auto p-1 ${menuPositionClass}`}
        >
          {AGENT_AVATAR_OPTIONS.map((option) => {
            const active = option.key === value;
            return (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                  active
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <AgentAvatar avatarKey={option.key} size="md" decorative />
                <span className="flex-1 truncate">{option.label}</span>
                {active ? (
                  <Check className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent)]" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
