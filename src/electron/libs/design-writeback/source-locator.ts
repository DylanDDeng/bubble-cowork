// Locate a JSX element in source text from a runtime anchor, classify its
// className shape, and produce a minimal surgical edit.
//
// Anchor matching deliberately does NOT trust exact column numbers: column
// conventions differ across Babel (1-based), @babel/parser (0-based) and
// SWC/esbuild toolchains. The key is file + line + tagName + same-line index,
// with the className snapshot as a staleness fingerprint (review finding:
// after the file hash changes, blind coordinate reuse must be refused).
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

export interface ElementAnchor {
  /** 1-based line of the JSX opening element (from fiber debugSource). */
  line: number;
  /** Tag as rendered ('div') or component name ('Button'). */
  tagName: string;
  /** Index among same-tag JSX elements on that line (0-based). */
  siblingIndex: number;
  /** Runtime className string at selection time (staleness fingerprint). */
  classNameSnapshot: string | null;
}

export type ClassNameShape =
  | { kind: 'none'; insertAt: number }
  | { kind: 'static'; valueStart: number; valueEnd: number; value: string }
  | { kind: 'cn-first-static'; valueStart: number; valueEnd: number; value: string; callEnd: number }
  | { kind: 'cn-dynamic'; callEnd: number }
  | { kind: 'dynamic' };

export interface LocatedElement {
  tagName: string;
  line: number;
  className: ClassNameShape;
}

export type LocateResult =
  | { ok: true; element: LocatedElement }
  | { ok: false; reason: 'parse-error' | 'not-found' | 'ambiguous' | 'stale-anchor'; detail: string };

const CN_CALLEES = new Set(['cn', 'clsx', 'cx', 'classnames', 'classNames', 'twMerge', 'twJoin']);

export function stripBom(code: string): { code: string; hadBom: boolean } {
  if (code.charCodeAt(0) === 0xfeff) return { code: code.slice(1), hadBom: true };
  return { code, hadBom: false };
}

function parseSource(code: string) {
  return parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: [
      'typescript',
      'jsx',
      ['decorators', { decoratorsBeforeExport: true }],
      'importAttributes',
    ],
  });
}

type AnyNode = { type: string; start?: number | null; end?: number | null; loc?: any } & Record<string, any>;

/** Minimal AST walk — no @babel/traverse dependency. */
function walk(node: AnyNode | null | undefined, visit: (node: AnyNode) => void): void {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const value = (node as any)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function jsxTagName(node: AnyNode): string | null {
  const name = node.name;
  if (!name) return null;
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') {
    const parts: string[] = [];
    let current: AnyNode | null = name;
    while (current) {
      if (current.type === 'JSXMemberExpression') {
        parts.unshift(current.property?.name ?? '');
        current = current.object;
      } else {
        parts.unshift(current.name ?? '');
        current = null;
      }
    }
    return parts.join('.');
  }
  return null;
}

function isStaticTemplate(node: AnyNode): boolean {
  return node.type === 'TemplateLiteral' && (node.expressions?.length ?? 0) === 0;
}

function classifyClassName(opening: AnyNode): ClassNameShape {
  const attrs: AnyNode[] = opening.attributes ?? [];
  let classAttr: AnyNode | null = null;
  for (const attr of attrs) {
    if (attr.type === 'JSXAttribute' && attr.name?.type === 'JSXIdentifier' && attr.name.name === 'className') {
      classAttr = attr;
      break;
    }
  }
  if (!classAttr) {
    // Insert right after the tag name (before attributes / closing bracket).
    const nameEnd = opening.name?.end ?? opening.start! + 1;
    const typeArgsEnd = opening.typeArguments?.end ?? opening.typeParameters?.end ?? null;
    return { kind: 'none', insertAt: typeArgsEnd ?? nameEnd };
  }

  const value = classAttr.value;
  if (!value) return { kind: 'dynamic' };

  if (value.type === 'StringLiteral') {
    return {
      kind: 'static',
      valueStart: value.start! + 1,
      valueEnd: value.end! - 1,
      value: value.value,
    };
  }

  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    if (!expr) return { kind: 'dynamic' };
    if (expr.type === 'StringLiteral') {
      return { kind: 'static', valueStart: expr.start! + 1, valueEnd: expr.end! - 1, value: expr.value };
    }
    if (isStaticTemplate(expr)) {
      return {
        kind: 'static',
        valueStart: expr.start! + 1,
        valueEnd: expr.end! - 1,
        value: expr.quasis?.[0]?.value?.cooked ?? '',
      };
    }
    if (expr.type === 'CallExpression' && expr.callee?.type === 'Identifier' && CN_CALLEES.has(expr.callee.name)) {
      const firstArg = expr.arguments?.[0];
      if (firstArg && firstArg.type === 'StringLiteral') {
        return {
          kind: 'cn-first-static',
          valueStart: firstArg.start! + 1,
          valueEnd: firstArg.end! - 1,
          value: firstArg.value,
          callEnd: expr.end!,
        };
      }
      return { kind: 'cn-dynamic', callEnd: expr.end! };
    }
    return { kind: 'dynamic' };
  }

  return { kind: 'dynamic' };
}

/** Whitespace-insensitive class-set equality for staleness fingerprinting. */
function classSetsEqual(a: string, b: string): boolean {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const item of setA) if (!setB.has(item)) return false;
  return true;
}

export function locateJsxElement(rawCode: string, anchor: ElementAnchor): LocateResult {
  const { code } = stripBom(rawCode);
  let ast: ReturnType<typeof parseSource>;
  try {
    ast = parseSource(code);
  } catch (error) {
    return { ok: false, reason: 'parse-error', detail: error instanceof Error ? error.message : String(error) };
  }

  const candidates: AnyNode[] = [];
  walk(ast.program as AnyNode, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    if (node.loc?.start?.line !== anchor.line) return;
    const tag = jsxTagName(node);
    if (tag !== anchor.tagName) return;
    candidates.push(node);
  });

  if (candidates.length === 0) {
    return { ok: false, reason: 'not-found', detail: `no <${anchor.tagName}> on line ${anchor.line}` };
  }

  let picked: AnyNode | null = null;
  if (candidates.length === 1) {
    picked = candidates[0];
    // A lone candidate with an out-of-range sibling index is a stale anchor,
    // not a match — refuse rather than guess.
    if (anchor.siblingIndex > 0 && anchor.siblingIndex >= candidates.length) {
      return { ok: false, reason: 'stale-anchor', detail: 'sibling index out of range for current file content' };
    }
  } else {
    if (anchor.siblingIndex >= candidates.length) {
      return { ok: false, reason: 'stale-anchor', detail: 'sibling index out of range for current file content' };
    }
    picked = candidates[anchor.siblingIndex];
  }

  const className = classifyClassName(picked);

  // Staleness fingerprint: for a static className the runtime snapshot must
  // equal the source text; a mismatch means the file changed since selection.
  if (anchor.classNameSnapshot !== null && className.kind === 'static') {
    if (!classSetsEqual(className.value, anchor.classNameSnapshot)) {
      return {
        ok: false,
        reason: 'stale-anchor',
        detail: `className in source ("${className.value}") no longer matches selection snapshot`,
      };
    }
  }

  return {
    ok: true,
    element: { tagName: anchor.tagName, line: anchor.line, className },
  };
}

export type FingerprintLocate =
  | { ok: true; line: number; siblingIndex: number }
  | { ok: false; reason: 'parse-error' | 'not-found' | 'ambiguous'; detail: string };

/**
 * Content-based fallback when the anchor line is untrustworthy (modern
 * @vitejs/plugin-react reports TRANSFORMED-module line numbers): find the
 * unique JSX element whose tag and STATIC className class-set match the
 * runtime snapshot. Ambiguity refuses — never guess between twins.
 */
export function locateLineByFingerprint(
  rawCode: string,
  tagName: string,
  classNameSnapshot: string | null
): FingerprintLocate {
  if (!classNameSnapshot || !classNameSnapshot.trim()) {
    return { ok: false, reason: 'not-found', detail: 'no className fingerprint to match on' };
  }
  const { code } = stripBom(rawCode);
  let ast: ReturnType<typeof parseSource>;
  try {
    ast = parseSource(code);
  } catch (error) {
    return { ok: false, reason: 'parse-error', detail: error instanceof Error ? error.message : String(error) };
  }
  const matches: Array<{ line: number; sameLineIndex: number }> = [];
  // sameLineIndex must live in the SAME index space locateJsxElement uses:
  // the position among ALL same-tag elements on the line (walk order =
  // document order for both), not just the static-className ones — otherwise
  // a dynamic-className twin earlier on the line shifts the pick.
  const perLineCounts = new Map<number, number>();
  walk(ast.program as AnyNode, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    if (jsxTagName(node) !== tagName) return;
    const line = node.loc?.start?.line as number | undefined;
    if (!line) return;
    const indexAmongAll = perLineCounts.get(line) ?? 0;
    perLineCounts.set(line, indexAmongAll + 1);
    const shape = classifyClassName(node);
    if (shape.kind !== 'static') return;
    if (!classSetsEqual(shape.value, classNameSnapshot)) return;
    matches.push({ line, sameLineIndex: indexAmongAll });
  });
  if (matches.length === 0) {
    return { ok: false, reason: 'not-found', detail: `no <${tagName}> with className "${classNameSnapshot}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `${matches.length} identical <${tagName}> elements share this className — cannot pick one safely`,
    };
  }
  return { ok: true, line: matches[0].line, siblingIndex: matches[0].sameLineIndex };
}

export type EditPlan =
  | { ok: true; newCode: string; editedSpan: { start: number; end: number }; strategy: 'static' | 'cn-first-static' | 'cn-append' | 'insert-attr' }
  | { ok: false; reason: 'dynamic-classname'; detail: string };

/**
 * Produce the minimal text edit that lands `mergedClassName` (for static
 * shapes) or appends `additionClasses` (cn-append tier). Returns new code
 * plus the edited span for reverse-patch construction.
 */
export function planClassNameEdit(
  rawCode: string,
  element: LocatedElement,
  options: { mergedClassName: string; additionClasses: string }
): EditPlan {
  const { code, hadBom } = stripBom(rawCode);
  const ms = new MagicString(code);
  const shape = element.className;
  // Span offsets are computed on BOM-stripped text; shift by 1 when the BOM
  // is re-attached so they stay valid against the on-disk content.
  const bomShift = hadBom ? 1 : 0;
  const finalize = (newCodeNoBom: string, start: number, length: number) => ({
    newCode: (hadBom ? '\ufeff' : '') + newCodeNoBom,
    editedSpan: { start: start + bomShift, end: start + bomShift + length },
  });

  if (shape.kind === 'static' || shape.kind === 'cn-first-static') {
    ms.overwrite(shape.valueStart, shape.valueEnd, options.mergedClassName);
    const { newCode, editedSpan } = finalize(ms.toString(), shape.valueStart, options.mergedClassName.length);
    return {
      ok: true,
      newCode,
      editedSpan,
      strategy: shape.kind === 'static' ? 'static' : 'cn-first-static',
    };
  }

  if (shape.kind === 'cn-dynamic') {
    // Conservative append (tier 4): adding one string argument to a
    // cn()/clsx() call is textually safe; whether it WINS is decided by the
    // verify loop, not assumed here.
    const insertAt = shape.callEnd - 1; // before the closing paren
    const inserted = `, ${JSON.stringify(options.additionClasses)}`;
    ms.appendLeft(insertAt, inserted);
    const { newCode, editedSpan } = finalize(ms.toString(), insertAt, inserted.length);
    return { ok: true, newCode, editedSpan, strategy: 'cn-append' };
  }

  if (shape.kind === 'none') {
    const attrText = ` className=${JSON.stringify(options.additionClasses)}`;
    ms.appendLeft(shape.insertAt, attrText);
    const { newCode, editedSpan } = finalize(ms.toString(), shape.insertAt, attrText.length);
    return { ok: true, newCode, editedSpan, strategy: 'insert-attr' };
  }

  return {
    ok: false,
    reason: 'dynamic-classname',
    detail: 'className is a dynamic expression (ternary/identifier/template with holes) — hand to agent',
  };
}
