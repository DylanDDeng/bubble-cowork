import type { ITheme } from '@xterm/xterm';

// Nerd Font variants first so prompt glyphs render, then system symbol fonts.
const FALLBACK_FONT_STACK = [
  '"0xProto Nerd Font Mono"',
  '"0xProto Nerd Font"',
  '"0xProtoNFM"',
  '"0xProtoNF"',
  '"MesloLGS NF"',
  '"MesloLGS Nerd Font Mono"',
  '"JetBrainsMono Nerd Font Mono"',
  '"JetBrainsMono Nerd Font"',
  '"JetBrainsMono NFM"',
  '"JetBrainsMono NF"',
  '"Hack Nerd Font Mono"',
  '"Symbols Nerd Font Mono"',
  '"Apple Symbols"',
  '"Apple Color Emoji"',
  'monospace',
].join(', ');

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/** The app's terminal font setting, or a stack that covers prompt glyphs. */
export function terminalFontStack(): string {
  return readToken(getComputedStyle(document.documentElement), '--terminal-font-family', FALLBACK_FONT_STACK);
}

/**
 * Terminal colors derived from the current app theme tokens, so embedded
 * terminals follow light/dark and custom themes. ANSI hues reuse the app's
 * status colors; the background matches the pane surface.
 */
export function terminalPalette(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains('dark');
  const token = (name: string, fallback: string) => readToken(styles, name, fallback);

  const surface = token('--bg-secondary', '#ffffff');
  const ink = token('--text-primary', '#111111');
  const subdued = token('--text-secondary', '#62646A');
  const faint = token('--text-muted', '#989BA3');
  const accent = token('--accent', '#111827');
  const ok = token('--success', '#22c55e');
  const warn = token('--warning', '#f59e0b');
  const bad = token('--error', '#ef4444');
  const scrollAlpha = (light: number, darkAlpha: number) =>
    dark ? `rgba(255, 255, 255, ${darkAlpha})` : `rgba(0, 0, 0, ${light})`;

  const pair = (normal: string, bright = normal) => ({ normal, bright });
  const ansi = {
    black: pair(dark ? token('--bg-primary', '#ffffff') : '#2c3542', faint),
    red: pair(bad),
    green: pair(ok),
    yellow: pair(warn),
    blue: pair(accent),
    magenta: pair(accent),
    cyan: pair(subdued),
    white: pair(ink),
  };

  return {
    background: surface,
    foreground: ink,
    cursor: accent,
    cursorAccent: surface,
    selectionBackground: 'rgba(148, 163, 184, 0.18)',
    scrollbarSliderBackground: scrollAlpha(0.1, 0.07),
    scrollbarSliderHoverBackground: scrollAlpha(0.18, 0.14),
    scrollbarSliderActiveBackground: scrollAlpha(0.24, 0.2),
    black: ansi.black.normal,
    brightBlack: ansi.black.bright,
    red: ansi.red.normal,
    brightRed: ansi.red.bright,
    green: ansi.green.normal,
    brightGreen: ansi.green.bright,
    yellow: ansi.yellow.normal,
    brightYellow: ansi.yellow.bright,
    blue: ansi.blue.normal,
    brightBlue: ansi.blue.bright,
    magenta: ansi.magenta.normal,
    brightMagenta: ansi.magenta.bright,
    cyan: ansi.cyan.normal,
    brightCyan: ansi.cyan.bright,
    white: ansi.white.normal,
    brightWhite: ansi.white.bright,
  };
}
