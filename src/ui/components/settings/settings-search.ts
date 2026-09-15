import { SHORTCUT_COMMANDS } from '../../../shared/keyboard-shortcuts';
import type { McpSettingsRuntime, SettingsTab } from '../../types';

export interface SettingsSearchEntry { tab: SettingsTab; label: string; keywords: string; id?: string; runtime?: McpSettingsRuntime; scope?: string; }
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {tab: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'keymap hotkey bindings 快捷键 键盘'},
  ...SHORTCUT_COMMANDS.map(c => ({tab: 'shortcuts' as const, label: c.title, id: `shortcut:${c.id}`, keywords: 'keyboard shortcut keymap 快捷键'})),
  ...[
    ['general', 'General', 'preferences 通用'], ['profile', 'Profile', 'account avatar name 个人资料 头像'], ['appearance', 'Appearance', 'theme 外观'],
    ['browser', 'Browser', 'cookies browsing 浏览器'], ['providers', 'Providers', 'api key models 模型 密钥'],
    ['mcp', 'MCP Servers', 'tools 工具'], ['usage', 'Usage', 'cost tokens 费用 用量'], ['bridge', 'Bridge', 'channels remote 远程'],
  ].map(([tab, label, keywords]) => ({ tab: tab as SettingsTab, label, keywords })),
  ...[
    ['Default open destination', 'editor finder vscode folder 默认 打开 编辑器'],
    ['Terminal shell', 'bash zsh powershell terminal 终端'],
    ['Prevent sleep while running', 'awake power sleep 防休眠'],
    ['Plain text input', 'composer links text 纯文本'],
    ['Show context usage', 'tokens ring context 上下文'],
    ['Send with', 'enter keyboard multiline send 发送 快捷键'],
    ['Follow-up behavior', 'queue steer follow up 排队 引导'],
    ['Task completed', 'notifications background always 通知'],
    ['Input required', 'notifications question user 通知 输入'],
    ['Approval required', 'notifications permissions 通知 权限'],
    ['Updates', 'application version 更新 版本'],
  ].map(([label, keywords]) => ({ tab: 'general' as const, label, keywords })),
  ...['Mode', 'Skin', 'UI font size', 'Code font size', 'Font smoothing', 'Reduce motion', 'Use pointer cursors', 'Diff markers'].map(label => ({ tab: 'appearance' as const, label, keywords: 'theme light dark font size motion animation pointer diff wallpaper 外观 主题 字体 字号 动画 壁纸' })),
  ...['Light Theme', 'Dark Theme'].map(label => ({ tab: 'appearance' as const, label, keywords: 'accent background foreground contrast content font style weight translucent 主题 颜色 对比度' })),
  ...['Display name', 'Handle'].map(label => ({ tab: 'profile' as const, label, keywords: 'profile name account 资料 用户名' })),
  ...[
    ['browser', 'Enable Browser Use', 'agent browsing 浏览器 权限 开关'],
    ['browser', 'Import from Chrome', 'cookies login chrome 导入 登录'],
    ['browser', 'Imported cookies', 'clear cookies 清除 cookie'],
    ['bridge', 'Bridge enabled', 'feishu lark 飞书 桥接 开关'],
    ['bridge', 'State', 'feishu start stop 飞书 启动 停止 状态'],
    ['bridge', 'App ID', 'feishu credentials 飞书 凭证'],
    ['bridge', 'App Secret', 'feishu credentials 飞书 密钥'],
    ['bridge', 'Default workspace', 'feishu cwd directory folder 工作目录'],
    ['bridge', 'Runtime', 'feishu agent provider 代理'],
    ['bridge', 'Default model', 'feishu advanced model 模型 高级'],
    ['bridge', 'Allowed user IDs', 'feishu advanced permissions allowlist 权限 白名单'],
    ['bridge', 'Start on launch', 'feishu advanced autostart 自动启动'],
    ['usage', 'Usage provider', 'cost tokens limits agent 用量 费用 额度'],
    ['mcp', 'Add server', 'connect command url 添加 服务器'],
    ['providers', 'Claude Code', 'anthropic api key 密钥'],
    ['providers', 'Bubble', 'api key default 密钥 默认'],
    ['providers', 'DeepSeek Harness', 'deepseek api key 密钥'],
  ].map(([tab, label, keywords]) => ({ tab: tab as SettingsTab, label, keywords })),

];

export function findSettings(query: string, additional: SettingsSearchEntry[] = []): SettingsSearchEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  const rank = (entry: SettingsSearchEntry) => {
    const label = entry.label.toLocaleLowerCase();
    return label === phrase ? 3 : label.startsWith(phrase) ? 2 : words.every(word => label.includes(word)) ? 1 : 0;
  };
  return [...SETTINGS_SEARCH_ENTRIES, ...additional]
    .filter(entry => words.every(word => `${entry.label} ${entry.keywords} ${entry.tab} ${entry.scope ?? ''}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => rank(b) - rank(a));
}
