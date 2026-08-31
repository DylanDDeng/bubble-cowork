import assert from 'node:assert/strict';
import { parseMarkdownDocument } from '../../src/ui/utils/markdown-frontmatter';

const sample = `---
title: "为什么大模型会有幻觉"
description: >-
  不讲公式，从猜下一个词这件事出发，
  看明白大模型为什么会编造不存在的内容。
date: 2026-08-30
draft: false
weight: 1
tags: [新手村, 大模型]
authors:
  - Bubble
  - Codex
source:
  repo: coworker
---

# 幻觉长什么样

正文内容。
`;

const parsed = parseMarkdownDocument(sample);
assert.ok(parsed.frontmatter);
assert.equal(parsed.frontmatter.parseError, null);
assert.equal(parsed.frontmatter.fields.length, 8);
assert.deepEqual(parsed.frontmatter.fields[0], {
  key: 'title',
  kind: 'text',
  value: '为什么大模型会有幻觉',
});
assert.equal(
  parsed.frontmatter.fields.find((field) => field.key === 'description')?.value,
  '不讲公式，从猜下一个词这件事出发， 看明白大模型为什么会编造不存在的内容。'
);
assert.deepEqual(parsed.frontmatter.fields.find((field) => field.key === 'draft'), {
  key: 'draft',
  kind: 'boolean',
  value: 'false',
});
assert.deepEqual(parsed.frontmatter.fields.find((field) => field.key === 'tags'), {
  key: 'tags',
  kind: 'array',
  value: '新手村, 大模型',
});
assert.deepEqual(parsed.frontmatter.fields.find((field) => field.key === 'source'), {
  key: 'source',
  kind: 'object',
  value: '{"repo":"coworker"}',
});
assert.ok(parsed.body.startsWith('# 幻觉长什么样'));
assert.equal(parsed.body.includes('title:'), false);

const plain = '# Plain markdown\n\nNo metadata.';
assert.deepEqual(parseMarkdownDocument(plain), {
  frontmatter: null,
  body: plain,
});

const invalid = parseMarkdownDocument(`---\ntitle: [broken\n---\n\n# Body survives`);
assert.ok(invalid.frontmatter?.parseError);
assert.equal(invalid.body, '# Body survives');
assert.equal(invalid.frontmatter?.raw, 'title: [broken');

const unclosed = parseMarkdownDocument(`---\ntitle: Unclosed\n# Still source`);
assert.equal(unclosed.frontmatter?.parseError, 'Missing closing front matter delimiter.');
assert.equal(unclosed.frontmatter?.raw, 'title: Unclosed\n# Still source');

console.log('markdown front matter parser regression passed');
