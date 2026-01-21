import type { StatusConfig } from '../../shared/types';

// 默认图标映射
const DEFAULT_ICONS: Record<string, string> = {
  'backlog': '◌',
  'todo': '○',
  'needs-review': '⊙',
  'done': '✓',
  'cancelled': '✕',
};

// 默认颜色映射
const DEFAULT_COLORS: Record<string, string> = {
  'backlog': 'text-gray-400',
  'todo': 'text-gray-400',
  'needs-review': 'text-amber-500',
  'done': 'text-green-500',
  'cancelled': 'text-gray-400',
};

interface StatusIconProps {
  status: StatusConfig;
  className?: string;
}

export function StatusIcon({ status, className = '' }: StatusIconProps) {
  const icon = status.icon || DEFAULT_ICONS[status.id] || '●';
  const color = status.color || DEFAULT_COLORS[status.id] || 'text-gray-400';

  // 判断是否是 hex 颜色
  const isHexColor = color.startsWith('#');

  return (
    <span
      className={`text-sm ${!isHexColor ? color : ''} ${className}`}
      style={isHexColor ? { color } : undefined}
      title={status.label}
    >
      {icon}
    </span>
  );
}

// 根据状态 ID 获取图标 (用于没有完整 StatusConfig 的场景)
export function getStatusIconById(statusId: string): string {
  return DEFAULT_ICONS[statusId] || '●';
}

// 根据状态 ID 获取颜色类名
export function getStatusColorById(statusId: string): string {
  return DEFAULT_COLORS[statusId] || 'text-gray-400';
}
