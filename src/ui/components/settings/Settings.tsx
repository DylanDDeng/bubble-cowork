import { useAppStore } from '../../store/useAppStore';
import { McpSettingsContent } from './McpSettings';
import type { SettingsTab } from '../../types';

// Settings 面板
export function Settings() {
  const {
    showSettings,
    setShowSettings,
    activeSettingsTab,
    setActiveSettingsTab,
  } = useAppStore();

  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-primary)] rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex overflow-hidden">
        {/* 左侧导航 */}
        <nav className="w-48 border-r border-[var(--border-primary)] p-4 flex-shrink-0 bg-[var(--bg-secondary)]">
          <div className="text-sm font-semibold mb-4 text-[var(--text-muted)]">Settings</div>
          <ul className="space-y-1">
            <SettingsNavItem
              label="MCP Servers"
              icon={<McpIcon />}
              active={activeSettingsTab === 'mcp'}
              onClick={() => setActiveSettingsTab('mcp')}
            />
            {/* 未来可添加更多标签 */}
            {/* <SettingsNavItem label="General" icon={<GeneralIcon />} ... /> */}
          </ul>
        </nav>

        {/* 右侧内容区 */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header with close button */}
          <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-primary)]">
            <h2 className="text-lg font-semibold">
              {activeSettingsTab === 'mcp' && 'MCP Servers'}
              {activeSettingsTab === 'general' && 'General'}
            </h2>
            <button
              onClick={() => setShowSettings(false)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <CloseIcon />
            </button>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {activeSettingsTab === 'mcp' && <McpSettingsContent />}
          </div>
        </div>
      </div>
    </div>
  );
}

// 导航项组件
function SettingsNavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
          active
            ? 'bg-[var(--accent-light)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--text-primary)]/5 hover:text-[var(--text-primary)]'
        }`}
      >
        {icon}
        <span>{label}</span>
      </button>
    </li>
  );
}

// Icons
function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}
