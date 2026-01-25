import { X, Server, Settings as SettingsIcon, Sun, Moon, Monitor } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { McpSettingsContent } from './McpSettings';
import type { Theme } from '../../types';

// Settings 面板
export function Settings() {
  const {
    showSettings,
    setShowSettings,
    activeSettingsTab,
    setActiveSettingsTab,
    theme,
    setTheme,
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
              label="General"
              icon={<SettingsIcon className="w-4 h-4" />}
              active={activeSettingsTab === 'general'}
              onClick={() => setActiveSettingsTab('general')}
            />
            <SettingsNavItem
              label="MCP Servers"
              icon={<Server className="w-4 h-4" />}
              active={activeSettingsTab === 'mcp'}
              onClick={() => setActiveSettingsTab('mcp')}
            />
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
              <X className="w-5 h-5" />
            </button>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {activeSettingsTab === 'general' && (
              <GeneralSettingsContent theme={theme} setTheme={setTheme} />
            )}
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

// General Settings Content
function GeneralSettingsContent({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  return (
    <div className="p-6 space-y-6">
      {/* Theme Section */}
      <div>
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">Appearance</h3>
        <div className="flex gap-2">
          <ThemeButton
            label="Light"
            value="light"
            current={theme}
            onClick={() => setTheme('light')}
            icon={<Sun className="w-4 h-4" />}
          />
          <ThemeButton
            label="Dark"
            value="dark"
            current={theme}
            onClick={() => setTheme('dark')}
            icon={<Moon className="w-4 h-4" />}
          />
          <ThemeButton
            label="System"
            value="system"
            current={theme}
            onClick={() => setTheme('system')}
            icon={<Monitor className="w-4 h-4" />}
          />
        </div>
      </div>
    </div>
  );
}

// Theme Button
function ThemeButton({
  label,
  value,
  current,
  onClick,
  icon,
}: {
  label: string;
  value: Theme;
  current: Theme;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const isActive = current === value;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
        isActive
          ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--text-primary)]'
          : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
      }`}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

