---
name: review-proposal
description: Analyze a technical proposal or design review document from agent-review-issues/ and provide structured feedback without modifying code. Use when the user asks to "review", "analyze", or "evaluate" a proposal document.
---

# Review Proposal

Analyze a technical proposal or design review document and provide structured feedback.

## When to use

- User asks to "review", "analyze", or "evaluate" a document in `agent-review-issues/`
- User says "只分析不改代码" (analyze only, don't modify code)
- User shares a design brief or technical proposal for feedback

## Procedure

### Step 1: Locate and read the document

```bash
ls /Users/chengshengdeng/coworker/agent-review-issues/
```

Read the full document using the Read tool.

### Step 2: Understand the codebase context

Use targeted grep/read to understand the current implementation areas referenced in the document:

```bash
grep -n "KeySymbol\|KeyFunction\|KeyType" /Users/chengshengdeng/coworker/src/path/to/relevant/files
```

Focus on the specific code paths mentioned in the proposal.

### Step 3: Analyze the proposal

Evaluate the document on these dimensions:

1. **Problem clarity**: Does the document clearly state what problem it solves?
2. **Solution fit**: Does the proposed solution address the stated problem without introducing new issues?
3. **Edge cases**: Are boundary conditions and error scenarios considered?
4. **Backward compatibility**: Will the change break existing behavior?
5. **Implementation risk**: Are there areas that are fragile, complex, or likely to cause regressions?
6. **Missing pieces**: What's not addressed that should be?

### Step 4: Deliver structured feedback

Organize findings as:

- **Strengths**: What the proposal does well
- **Issues found**: Specific problems with file:line references where applicable
- **Suggestions**: Concrete improvements or alternatives
- **Verdict**: Approve / Approve with changes / Needs revision

## Notes

- The `agent-review-issues/` directory contains review briefs for independent analysis.
- Always reference specific code paths when critiquing — don't make vague claims.
- If the user says "只评审分析" (review and analyze only), do NOT modify any files.
