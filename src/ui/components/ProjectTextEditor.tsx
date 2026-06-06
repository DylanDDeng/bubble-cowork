import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  KeyBinding,
} from '@codemirror/view';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

interface ProjectTextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  className?: string;
  revealTarget?: { line: number; token: number } | null;
}

export interface ProjectTextEditorHandle {
  /** Force a content flush; in plain-text source mode the doc is the source, so this is a no-op kept for API parity. */
  flush: () => void;
  /** Whether an IME composition is currently active in the editor. */
  isComposing: () => boolean;
  /** Capture enough view state to restore source editing after a file tab switch. */
  getViewState: () => ProjectTextEditorViewState | null;
  /** Restore source selection and scroll position after remounting the editor. */
  restoreViewState: (state: ProjectTextEditorViewState | null | undefined) => void;
}

export interface ProjectTextEditorViewState {
  selectionFrom: number;
  selectionTo: number;
  scrollTop: number;
}

// Minimal undo/redo stack since @codemirror/commands is not a dependency
class UndoManager {
  private stack: string[] = [];
  private index = -1;
  private maxSize = 200;

  push(state: string) {
    // Trim future redo entries
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(state);
    this.index = this.stack.length - 1;
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
      this.index--;
    }
  }

  undo(current: string): string | null {
    if (this.index <= 0) return null;
    // If the current document doesn't match the top of stack, push it first
    if (this.stack[this.index] !== current) {
      this.push(current);
      this.index--; // skip the newly pushed entry
    } else {
      this.index--;
    }
    return this.stack[this.index];
  }

  redo(): string | null {
    if (this.index >= this.stack.length - 1) return null;
    this.index++;
    return this.stack[this.index];
  }

  clear() {
    this.stack = [];
    this.index = -1;
  }
}

export const ProjectTextEditor = forwardRef<ProjectTextEditorHandle, ProjectTextEditorProps>(function ProjectTextEditor({
  value,
  onChange,
  onSave,
  className,
  revealTarget,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const isInternalChangeRef = useRef(false);
  const composingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    flush: () => {
      // Source mode: the CodeMirror doc is the source string. No serialization,
      // so flush is a no-op kept for API parity with markdown editors.
    },
    isComposing: () => composingRef.current,
    getViewState: () => {
      const view = viewRef.current;
      if (!view) return null;
      const selection = view.state.selection.main;
      return {
        selectionFrom: selection.from,
        selectionTo: selection.to,
        scrollTop: view.scrollDOM.scrollTop,
      };
    },
    restoreViewState: (state) => {
      const view = viewRef.current;
      if (!view || !state) return;
      const selectionFrom = Math.max(0, Math.min(state.selectionFrom, view.state.doc.length));
      const selectionTo = Math.max(selectionFrom, Math.min(state.selectionTo, view.state.doc.length));
      view.dispatch({
        selection: EditorSelection.range(selectionFrom, selectionTo),
      });
      window.requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = Math.max(0, state.scrollTop);
      });
    },
  }), []);
  const undoManagerRef = useRef(new UndoManager());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!containerRef.current) return;
    const um = undoManagerRef.current;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        isInternalChangeRef.current = true;
        const newValue = update.state.doc.toString();
        // Push to undo stack (debounce: only for user-initiated changes)
        if (!update.transactions.some((tr) => tr.annotation(Transaction.userEvent) === 'undo-redo')) {
          um.push(newValue);
        }
        onChangeRef.current?.(newValue);
        isInternalChangeRef.current = false;
      }
    });

    const customKeymap: readonly KeyBinding[] = [
      {
        key: 'Mod-s',
        run: () => {
          onSaveRef.current?.();
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Mod-z',
        run: (view: EditorView) => {
          const current = view.state.doc.toString();
          const prev = um.undo(current);
          if (prev !== null) {
            view.dispatch({
              changes: { from: 0, to: current.length, insert: prev },
              annotations: Transaction.userEvent.of('undo-redo'),
            });
          }
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Mod-Shift-z',
        run: (view: EditorView) => {
          const next = um.redo();
          if (next !== null) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.toString().length, insert: next },
              annotations: Transaction.userEvent.of('undo-redo'),
            });
          }
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Mod-y',
        run: (view: EditorView) => {
          const next = um.redo();
          if (next !== null) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.toString().length, insert: next },
              annotations: Transaction.userEvent.of('undo-redo'),
            });
          }
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Tab',
        run: (view: EditorView) => {
          // Insert 2 spaces at cursor or indent selected lines
          const { state } = view;
          const indent = '  ';
          view.dispatch(
            state.changeByRange((range) => {
              if (range.empty) {
                return { changes: [{ from: range.from, insert: indent }], range: EditorSelection.cursor(range.from + indent.length) };
              }
              // Multi-line selection: indent each line
              const fromLine = state.doc.lineAt(range.from).number;
              const toLine = state.doc.lineAt(range.to).number;
              const cb: { from: number; to: number; insert: string }[] = [];
              for (let i = fromLine; i <= toLine; i++) {
                const line = state.doc.line(i);
                cb.push({ from: line.from, to: line.from, insert: indent });
              }
              return { changes: cb, range };
            }),
          );
          return true;
        },
        preventDefault: true,
      },
      {
        key: 'Shift-Tab',
        run: (view: EditorView) => {
          // Remove up to 2 spaces from start of selected lines
          const { state } = view;
          view.dispatch(
            state.changeByRange((range) => {
              const doc = state.doc;
              const fromLine = doc.lineAt(range.from);
              const toLine = doc.lineAt(range.to);
              const changes: { from: number; to: number; insert: string }[] = [];
              for (let i = fromLine.number; i <= toLine.number; i++) {
                const line = doc.line(i);
                const text = line.text;
                const leading = text.match(/^ {1,2}/);
                if (leading) {
                  changes.push({ from: line.from, to: line.from + leading[0].length, insert: '' });
                }
              }
              return changes.length > 0 ? { range, changes } : { range };
            }),
          );
          return true;
        },
        preventDefault: true,
      },
    ];

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of(customKeymap),
      updateListener,
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
      }),
      EditorView.theme({
        '&': {
          height: '100%',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: '14px',
        },
        '.cm-content': {
          padding: '12px',
          caretColor: 'var(--text-primary)',
        },
        '.cm-gutters': {
          borderRight: '1px solid var(--border)',
          backgroundColor: 'var(--panel-bg)',
          color: 'var(--text-muted)',
        },
        '.cm-activeLine': {
          backgroundColor: 'var(--hover-bg)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--hover-bg)',
        },
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    um.push(value); // initial state

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g., file reload from disk)
  useEffect(() => {
    const view = viewRef.current;
    if (!view || isInternalChangeRef.current) return;
    const currentValue = view.state.doc.toString();
    if (value !== currentValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      });
      undoManagerRef.current.clear();
      undoManagerRef.current.push(value);
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealTarget) return;

    const lineNumber = Math.max(1, Math.min(revealTarget.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  }, [revealTarget]);

  return (
    <div
      ref={containerRef}
      className={`aegis-text-codemirror-host h-full ${className ?? ''}`}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
    />
  );
});
