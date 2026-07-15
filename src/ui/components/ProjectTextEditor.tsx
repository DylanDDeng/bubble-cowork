import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, EditorSelection, Transaction } from '@codemirror/state';
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
  LanguageDescription,
} from '@codemirror/language';
import { history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

interface ProjectTextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  className?: string;
  revealTarget?: { line: number; token: number } | null;
  /**
   * File name used to pick the syntax language by extension. Without it the
   * editor falls back to Markdown (the historical default, correct for the
   * MDX call sites) — code files MUST pass it or they get Markdown parsing.
   */
  fileName?: string;
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

/**
 * Pick the syntax language for a file name. Markdown stays the default (the
 * MDX call sites rely on it); everything else resolves through
 * @codemirror/language-data by extension. Returns null when the file should
 * be plain text (unknown extension).
 */
function resolveLanguageDescription(fileName: string | undefined): LanguageDescription | null {
  const name = fileName?.trim();
  if (!name) return null;
  return LanguageDescription.matchFilename(languages, name);
}

export const ProjectTextEditor = forwardRef<ProjectTextEditorHandle, ProjectTextEditorProps>(function ProjectTextEditor({
  value,
  onChange,
  onSave,
  className,
  revealTarget,
  fileName,
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
  // History lives in a compartment so external disk reloads can reset the
  // undo stack (reconfiguring the compartment recreates the history field).
  const historyCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        isInternalChangeRef.current = true;
        onChangeRef.current?.(update.state.doc.toString());
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
      historyCompartmentRef.current.of(history()),
      keymap.of([...customKeymap, ...historyKeymap]),
      updateListener,
      EditorView.lineWrapping,
      // Language is applied by the fileName effect below (the editor instance
      // is reused across file switches, so it can't be fixed at mount).
      languageCompartmentRef.current.of([]),
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
          border: 'none',
          backgroundColor: 'transparent',
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

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the language for the current file. Runs on mount and whenever the
  // same editor instance is pointed at a different file. Matched languages
  // load their module async (mounting plain in the meantime); unmatched files
  // keep the historical Markdown default (MDX call sites rely on it).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    const description = resolveLanguageDescription(fileName);
    if (!description) {
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure(
          markdown({ base: markdownLanguage, codeLanguages: languages })
        ),
      });
      return;
    }
    view.dispatch({ effects: languageCompartmentRef.current.reconfigure([]) });
    void description
      .load()
      .then((support) => {
        if (cancelled || viewRef.current !== view) return;
        view.dispatch({ effects: languageCompartmentRef.current.reconfigure(support) });
      })
      .catch(() => {
        // Language module failed to load: stay plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

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
        annotations: Transaction.addToHistory.of(false),
      });
      // A disk reload starts a fresh undo timeline: reconfiguring the
      // history compartment recreates its state field, dropping the stack.
      view.dispatch({ effects: historyCompartmentRef.current.reconfigure([]) });
      view.dispatch({ effects: historyCompartmentRef.current.reconfigure(history()) });
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
