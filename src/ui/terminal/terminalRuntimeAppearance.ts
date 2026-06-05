import type { ITheme, Terminal } from '@xterm/xterm';

export function getTerminalFontFamily(): string {
  const styles = getComputedStyle(document.documentElement);
  const configured = styles.getPropertyValue('--terminal-font-family').trim();
  return (
    configured ||
    "\"0xProto Nerd Font Mono\", \"0xProto Nerd Font\", \"0xProtoNFM\", \"0xProtoNF\", \"MesloLGS NF\", \"MesloLGS Nerd Font Mono\", \"JetBrainsMono Nerd Font Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", \"JetBrainsMono NF\", \"Hack Nerd Font Mono\", \"Symbols Nerd Font Mono\", \"Apple Symbols\", \"Apple Color Emoji\", monospace"
  );
}

export function terminalThemeFromApp(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains('dark');
  const bgPrimary = styles.getPropertyValue('--bg-primary').trim() || '#ffffff';
  const bgSecondary = styles.getPropertyValue('--bg-secondary').trim() || '#ffffff';
  const textPrimary = styles.getPropertyValue('--text-primary').trim() || '#111111';
  const textSecondary = styles.getPropertyValue('--text-secondary').trim() || '#62646A';
  const textMuted = styles.getPropertyValue('--text-muted').trim() || '#989BA3';
  const accent = styles.getPropertyValue('--accent').trim() || '#111827';
  const success = styles.getPropertyValue('--success').trim() || '#22c55e';
  const warning = styles.getPropertyValue('--warning').trim() || '#f59e0b';
  const error = styles.getPropertyValue('--error').trim() || '#ef4444';

  return {
    background: bgSecondary,
    foreground: textPrimary,
    cursor: accent,
    cursorAccent: bgSecondary,
    selectionBackground: 'rgba(148, 163, 184, 0.18)',
    scrollbarSliderBackground: isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.10)',
    scrollbarSliderHoverBackground: isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.18)',
    scrollbarSliderActiveBackground: isDark ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.24)',
    black: isDark ? bgPrimary : '#2c3542',
    brightBlack: textMuted,
    red: error,
    brightRed: error,
    green: success,
    brightGreen: success,
    yellow: warning,
    brightYellow: warning,
    blue: accent,
    brightBlue: accent,
    magenta: accent,
    brightMagenta: accent,
    cyan: textSecondary,
    brightCyan: textSecondary,
    white: textPrimary,
    brightWhite: textPrimary,
  };
}

export function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.writeln(`\x1b[90m${message}\x1b[0m`);
}
