// The pure heart of the write-back engine: given file content, a runtime
// anchor and a set of CSS edits, produce either a deterministic text edit
// (new content + reverse patch + verification expectations) or an explicit
// refusal that the caller routes to the agent lane. No fs, no CDP — fully
// unit-testable.
import { mapEditToClass, mergeClassName, applyVariantHint } from './tailwind-map';
import { locateJsxElement, planClassNameEdit, type ElementAnchor } from './source-locator';
import { createReversePatch, type ReversePatch } from './patch';

export interface CssEdit {
  /** CSS property in kebab-case, e.g. 'padding-top'. */
  property: string;
  /** Target value as the drawer resolved it, e.g. '24px' or '#1a2b3c'. */
  value: string;
}

export interface WritebackRequest {
  filePath: string;
  fileContent: string;
  anchor: ElementAnchor;
  edits: CssEdit[];
  /** Winning variant prefix for the edited property, e.g. 'md:' (red-team C4). */
  variantHint?: string | null;
}

export type WritebackPlan =
  | {
      ok: true;
      strategy: 'static' | 'cn-first-static' | 'cn-append' | 'insert-attr';
      newContent: string;
      reversePatch: ReversePatch;
      /** Classes the edit adds — verification asserts these appear in the DOM class list. */
      addedClasses: string[];
      /** Classes the merge removed — verification asserts these are gone. */
      removedClasses: string[];
      /** Properties expected to co-change (e.g. text-lg touches line-height). */
      alsoAffects: string[];
      /** Ambiguous var() arbitrary tokens deliberately preserved (red-team B4). */
      preservedTokens: string[];
    }
  | {
      ok: false;
      reason: 'unsupported-property' | 'parse-error' | 'not-found' | 'ambiguous' | 'stale-anchor' | 'dynamic-classname';
      detail: string;
    };

export function computeWritebackPlan(request: WritebackRequest): WritebackPlan {
  // 1. Map every CSS edit to a class. All-or-nothing per element: a partially
  //    mappable intent would leave the element half-edited.
  const additions: string[] = [];
  const alsoAffects = new Set<string>();
  for (const edit of request.edits) {
    const mapped = mapEditToClass(edit.property, edit.value);
    if (!mapped) {
      return {
        ok: false,
        reason: 'unsupported-property',
        detail: `no tailwind mapping for '${edit.property}' — use the agent lane`,
      };
    }
    additions.push(applyVariantHint(mapped.className, request.variantHint));
    for (const prop of mapped.alsoAffects) alsoAffects.add(prop);
  }
  const additionClasses = additions.join(' ');

  // 2. Locate the element and classify its className shape.
  const located = locateJsxElement(request.fileContent, request.anchor);
  if (!located.ok) {
    return { ok: false, reason: located.reason, detail: located.detail };
  }
  const shape = located.element.className;

  // 3. Compute the merged class string for statically editable shapes.
  let mergedClassName = additionClasses;
  let removedClasses: string[] = [];
  let preservedTokens: string[] = [];
  if (shape.kind === 'static' || shape.kind === 'cn-first-static') {
    const merge = mergeClassName(shape.value, additionClasses);
    mergedClassName = merge.merged;
    preservedTokens = merge.preserved;
    const mergedSet = new Set(merge.merged.split(/\s+/).filter(Boolean));
    removedClasses = shape.value
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => !mergedSet.has(token));
  }

  // 4. Produce the surgical edit.
  const plan = planClassNameEdit(request.fileContent, located.element, {
    mergedClassName,
    additionClasses,
  });
  if (!plan.ok) {
    return { ok: false, reason: plan.reason, detail: plan.detail };
  }

  return {
    ok: true,
    strategy: plan.strategy,
    newContent: plan.newCode,
    reversePatch: createReversePatch(request.filePath, request.fileContent, plan.newCode, plan.editedSpan),
    addedClasses: additions,
    removedClasses,
    alsoAffects: [...alsoAffects],
    preservedTokens,
  };
}
