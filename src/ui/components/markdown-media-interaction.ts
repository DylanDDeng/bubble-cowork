import { EditorSelection, Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

// Array.prototype.findLast needs lib es2023, which this project does not target.
function findLast<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return undefined;
}

// Media stays mounted when its source is revealed. Focus moving to a player or
// toolbar must not hide that source, and a drag selection must not expand it.
export function mediaSourceIsActive(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(range => range.empty && range.from >= from && range.from <= to);
}

export type MediaSourceRange = { from: number; to: number };

export function moveThroughMedia(view: EditorView, forward: boolean, media: MediaSourceRange[]) {
  const { state } = view;
  const selection = state.selection.main;
  if (view.composing || state.selection.ranges.length !== 1 || !selection.empty) return false;
  const next = view.moveVertically(selection, forward);
  const current = media.find(range => selection.head >= range.from && selection.head <= range.to);
  let target: number | undefined;
  if (current) {
    const caret = view.coordsAtPos(selection.head);
    const edge = view.coordsAtPos(forward ? current.to : current.from);
    // Within wrapped or multiline source, retain normal visual-line movement.
    // At its last/first visual row, bypass the non-text preview itself.
    if (!caret || !edge || Math.abs(caret.top - edge.top) > 2) return false;
    // Prefer CodeMirror's goal-column handling whenever it already reaches
    // the adjacent text line without skipping another media block.
    if (next.head < current.from || next.head > current.to) {
      const adjacent = forward
        ? media.find(range => range.from > current.to && range.from <= next.head)
        : findLast(media, range => range.to < current.from && range.to >= next.head);
      if (!adjacent) return false;
      target = forward ? adjacent.from : adjacent.to;
    }
    const boundary = state.doc.lineAt(forward ? current.to : current.from);
    const number = boundary.number + (forward ? 1 : -1);
    if (number < 1 || number > state.doc.lines) return false;
    const line = state.doc.line(number);
    const column = selection.head - state.doc.lineAt(selection.head).from;
    target ??= line.from + Math.min(column, line.length);
  } else {
    // CodeMirror's visual navigation skips replacement widgets. Intercept the
    // first media source crossed by that move, including a boundary landing.
    const crossed = forward
      ? media.find(range => range.from > selection.head && range.from <= next.head)
      : findLast(media, range => range.to < selection.head && range.to >= next.head);
    if (!crossed) return false;
    target = forward ? crossed.from : crossed.to;
  }
  view.dispatch({
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
    annotations: Transaction.userEvent.of('select'),
  });
  return true;
}

export function createMediaSourceButton(view: EditorView, container: HTMLElement, kind: 'image' | 'video') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `bubble-md-media-edit bubble-md-${kind}-edit`;
  button.textContent = '</>';
  button.title = kind === 'image' ? 'Edit image source' : 'Edit video source';
  button.setAttribute('aria-label', button.title);
  // Keep focus in the editor until the selection transaction is ready.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const pos = Number(container.dataset.sourcePos) + 1;
    view.dispatch({ selection: EditorSelection.cursor(Math.min(pos, view.state.doc.length)) });
    view.focus();
  });
  return button;
}
