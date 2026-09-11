import type { MouseEvent } from 'react';

/** Treat unused composer space like the editor, without stealing control clicks. */
export function focusComposerFromSurface(event: MouseEvent<HTMLDivElement>) {
  if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
  const surface = event.currentTarget;
  if (!surface.contains(event.target)) return;
  if (event.target.closest('a[href], button, input, select, textarea, [contenteditable="true"], [draggable="true"], [role="button"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])')) return;
  const editor = surface.querySelector<HTMLElement>('[contenteditable="true"]');
  if (editor) {
    event.preventDefault();
    editor.focus();
  }
}
