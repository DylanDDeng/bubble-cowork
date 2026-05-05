import { Compartment, EditorState } from '@codemirror/state';
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { exitCode } from '@milkdown/kit/prose/commands';
import { undo, redo } from '@milkdown/kit/prose/history';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as ProseEditorView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/utils';

class LanguageLoader {
  private readonly map: Record<string, LanguageDescription> = {};

  constructor(items: LanguageDescription[]) {
    items.forEach((language) => {
      this.map[language.name.toLowerCase()] = language;
      language.alias.forEach((alias) => {
        this.map[alias.toLowerCase()] = language;
      });
    });
  }

  load(languageName: string) {
    const language = this.map[languageName.toLowerCase()];
    if (!language) return Promise.resolve(undefined);
    if (language.support) return Promise.resolve(language.support);
    return language.load();
  }
}

class ProjectMarkdownCodeBlockView {
  private node: ProseNode;
  private readonly view: ProseEditorView;
  private readonly getPos: (() => number | undefined) | boolean;
  private readonly languageConf = new Compartment();
  private readonly readOnlyConf = new Compartment();
  private readonly loader = new LanguageLoader(languages);
  readonly dom: HTMLDivElement;
  private readonly cm: EditorView;
  private readonly host: HTMLDivElement;
  private readonly languageInput: HTMLInputElement;
  private readonly copyButton: HTMLButtonElement;
  private updating = false;
  private languageName = '';

  constructor(node: ProseNode, view: ProseEditorView, getPos: (() => number | undefined) | boolean) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'aegis-md-code-block';

    const tools = document.createElement('div');
    tools.className = 'aegis-md-code-tools';

    this.languageInput = document.createElement('input');
    this.languageInput.className = 'aegis-md-code-language';
    this.languageInput.type = 'text';
    this.languageInput.spellcheck = false;
    this.languageInput.placeholder = 'text';
    this.languageInput.value = String(node.attrs.language || '');
    this.languageInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.applyLanguage();
      this.cm.focus();
    });
    this.languageInput.addEventListener('blur', () => this.applyLanguage());

    this.copyButton = document.createElement('button');
    this.copyButton.className = 'aegis-md-code-copy';
    this.copyButton.type = 'button';
    this.copyButton.textContent = 'Copy';
    this.copyButton.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.cm.state.doc.toString()).then(() => {
        this.copyButton.dataset.copied = 'true';
        this.copyButton.textContent = 'Copied';
        window.setTimeout(() => {
          this.copyButton.removeAttribute('data-copied');
          this.copyButton.textContent = 'Copy';
        }, 1100);
      });
    });

    tools.appendChild(this.languageInput);
    tools.appendChild(this.copyButton);
    this.dom.appendChild(tools);

    this.host = document.createElement('div');
    this.host.className = 'aegis-md-codemirror-host';
    this.dom.appendChild(this.host);

    this.cm = new EditorView({
      doc: node.textContent,
      root: this.view.root,
      parent: this.host,
      extensions: [
        this.readOnlyConf.of(EditorState.readOnly.of(!this.view.editable)),
        keymap.of(this.codeMirrorKeymap()),
        this.languageConf.of([]),
        syntaxHighlighting(defaultHighlightStyle),
        EditorState.changeFilter.of(() => this.view.editable),
        EditorView.updateListener.of((update) => this.forwardUpdate(update)),
      ],
    });

    this.updateLanguage();
  }

  private codeMirrorKeymap() {
    const view = this.view;
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      {
        key: 'Mod-Enter',
        run: () => {
          if (!exitCode(view.state, view.dispatch)) return false;
          view.focus();
          return true;
        },
      },
      { key: 'Mod-z', run: () => undo(view.state, view.dispatch) },
      { key: 'Shift-Mod-z', run: () => redo(view.state, view.dispatch) },
      { key: 'Mod-y', run: () => redo(view.state, view.dispatch) },
    ];
  }

  private maybeEscape(unit: 'line' | 'char', dir: number) {
    const { state } = this.cm;
    const main = state.selection.main;
    if (!main.empty) return false;
    if (unit === 'line') {
      const line = state.doc.lineAt(main.head);
      if (dir < 0 ? line.from > 0 : line.to < state.doc.length) return false;
    } else if (dir < 0 ? main.from > 0 : main.to < state.doc.length) {
      return false;
    }

    const pos = typeof this.getPos === 'function' ? this.getPos() : undefined;
    const targetPos = (pos ?? 0) + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = TextSelection.near(this.view.state.doc.resolve(targetPos), dir);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  private forwardUpdate(update: ViewUpdate) {
    if (this.updating || !this.cm.hasFocus) return;

    let offset = ((typeof this.getPos === 'function' ? this.getPos() : undefined) ?? 0) + 1;
    const { main } = update.state.selection;
    const selFrom = offset + main.from;
    const selTo = offset + main.to;
    const pmSelection = this.view.state.selection;
    if (!update.docChanged && pmSelection.from === selFrom && pmSelection.to === selTo) return;

    const tr = this.view.state.tr;
    update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, text) => {
      if (text.length) {
        tr.replaceWith(offset + fromA, offset + toA, this.view.state.schema.text(text.toString()));
      } else {
        tr.delete(offset + fromA, offset + toA);
      }
      offset += toB - fromB - (toA - fromA);
    });
    tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
    this.view.dispatch(tr);
  }

  private applyLanguage() {
    const next = this.languageInput.value.trim();
    const pos = typeof this.getPos === 'function' ? this.getPos() : undefined;
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos ?? 0, 'language', next));
  }

  private updateLanguage() {
    const nextLanguageName = String(this.node.attrs.language || '');
    if (nextLanguageName === this.languageName) return;
    this.languageInput.value = nextLanguageName;
    this.loader.load(nextLanguageName)
      .then((language) => {
        this.cm.dispatch({
          effects: this.languageConf.reconfigure(language ?? []),
        });
        this.languageName = nextLanguageName;
      })
      .catch(() => {
        this.languageName = nextLanguageName;
      });
  }

  update(node: ProseNode) {
    if (node.type !== this.node.type) return false;
    if (this.updating) return true;
    this.node = node;
    this.updateLanguage();

    if (this.view.editable === this.cm.state.readOnly) {
      this.cm.dispatch({
        effects: this.readOnlyConf.reconfigure(EditorState.readOnly.of(!this.view.editable)),
      });
    }

    const change = computeChange(this.cm.state.doc.toString(), node.textContent);
    if (change) {
      this.updating = true;
      this.cm.dispatch({
        changes: { from: change.from, to: change.to, insert: change.text },
        scrollIntoView: true,
      });
      this.updating = false;
    }
    return true;
  }

  selectNode() {
    this.dom.classList.add('selected');
    this.cm.focus();
  }

  deselectNode() {
    this.dom.classList.remove('selected');
  }

  stopEvent(event: Event) {
    const target = event.target as Node | null;
    return Boolean(target && this.dom.contains(target));
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.cm.destroy();
  }
}

function computeChange(oldValue: string, newValue: string) {
  if (oldValue === newValue) return null;
  let start = 0;
  let oldEnd = oldValue.length;
  let newEnd = newValue.length;

  while (start < oldEnd && start < newEnd && oldValue.charCodeAt(start) === newValue.charCodeAt(start)) {
    start += 1;
  }

  while (oldEnd > start && newEnd > start && oldValue.charCodeAt(oldEnd - 1) === newValue.charCodeAt(newEnd - 1)) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return {
    from: start,
    to: oldEnd,
    text: newValue.slice(start, newEnd),
  };
}

export const projectMarkdownCodeBlockView = $view(codeBlockSchema.node, (): NodeViewConstructor => {
  return (node, view, getPos) => new ProjectMarkdownCodeBlockView(node, view, getPos);
});
