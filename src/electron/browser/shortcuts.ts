// Browser keyboard shortcuts taken while the page itself has focus. The page
// view sees these keys first (before-input-event); claiming them there also
// keeps the app menu from acting on them, so ⌘R reloads the page rather than
// the whole Aegis window.

export type BrowserShortcut =
  | 'focus-address'
  | 'find'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface ShortcutInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

/** The browser action a key press asks for, or null to leave it to the page. */
export function browserShortcutFor(input: ShortcutInput, mac: boolean): BrowserShortcut | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  const key = input.key.toLowerCase();
  switch (input.code) {
    case 'KeyL':
      return input.shift ? null : 'focus-address';
    case 'KeyF':
      return input.shift ? null : 'find';
    case 'KeyR':
      return input.shift ? 'hard-reload' : 'reload';
    case 'BracketLeft':
      return input.shift ? null : 'back';
    case 'BracketRight':
      return input.shift ? null : 'forward';
    case 'Equal':
    case 'NumpadAdd':
      return 'zoom-in';
    case 'Minus':
    case 'NumpadSubtract':
      return 'zoom-out';
    case 'Digit0':
    case 'Numpad0':
      return input.shift ? null : 'zoom-reset';
    default:
      // Layouts without a usable physical code: fall back to the character.
      if (!input.code) {
        if (key === 'l') return 'focus-address';
        if (key === 'f') return 'find';
        if (key === 'r') return input.shift ? 'hard-reload' : 'reload';
        if (key === '+' || key === '=') return 'zoom-in';
        if (key === '-') return 'zoom-out';
        if (key === '0') return 'zoom-reset';
      }
      return null;
  }
}

/** Chrome's zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 1;
  const index = ZOOM_STEPS.findIndex((step) => Math.abs(step - current) < 0.005);
  if (index >= 0) {
    return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + (direction === 'in' ? 1 : -1)))];
  }
  // Off the ladder (e.g. pinch zoom): move to the nearest step in that direction.
  return direction === 'in'
    ? ZOOM_STEPS.find((step) => step > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    : [...ZOOM_STEPS].reverse().find((step) => step < current) ?? ZOOM_STEPS[0];
}
