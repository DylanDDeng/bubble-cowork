import notionAvatar01 from '../assets/agent-avatars/notion-avatar-01.svg';
import notionAvatar02 from '../assets/agent-avatars/notion-avatar-02.svg';
import notionAvatar03 from '../assets/agent-avatars/notion-avatar-03.svg';
import notionAvatar04 from '../assets/agent-avatars/notion-avatar-04.svg';
import notionAvatar05 from '../assets/agent-avatars/notion-avatar-05.svg';
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
];

const AGENT_AVATAR_ASSETS: Record<AgentAvatarAssetKey, string> = {
  'notion-avatar-01': notionAvatar01,
  'notion-avatar-02': notionAvatar02,
  'notion-avatar-03': notionAvatar03,
  'notion-avatar-04': notionAvatar04,
  'notion-avatar-05': notionAvatar05,
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

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : resolvedLabel}
      className={`inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-primary)] ${AGENT_AVATAR_SIZE_CLASSES[size]} ${className}`}
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover"
        draggable={false}
      />
    </span>
  );
}
