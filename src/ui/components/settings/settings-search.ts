import type { SettingsTab } from '../../types';

export interface SettingsSearchEntry { tab: SettingsTab; label: string; keywords: string; }
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...[
    ['general', 'General', 'preferences 通用'], ['appearance', 'Appearance', 'theme 外观'],
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
  ...['Mode', 'Skin', 'UI Font Override', 'Code Font Override'].map(label => ({ tab: 'appearance' as const, label, keywords: 'theme light dark font wallpaper 外观 主题 字体 壁纸' })),
  ...['Light Theme', 'Dark Theme'].map(label => ({ tab: 'appearance' as const, label, keywords: 'accent background foreground contrast font translucent 主题 颜色 对比度' })),
  ...['Display name', 'Handle'].map(label => ({ tab: 'usage' as const, label, keywords: 'profile name account 资料 用户名' })),
];

export function findSettings(query: string): SettingsSearchEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  const rank = (entry: SettingsSearchEntry) => {
    const label = entry.label.toLocaleLowerCase();
    return label === phrase ? 3 : label.startsWith(phrase) ? 2 : words.every(word => label.includes(word)) ? 1 : 0;
  };
  return SETTINGS_SEARCH_ENTRIES
    .filter(entry => words.every(word => `${entry.label} ${entry.keywords} ${entry.tab}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => rank(b) - rank(a));
}
