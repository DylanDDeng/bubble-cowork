import assert from 'node:assert/strict';
import {
  extractKnownSiteLinkTokens,
  getKnownSiteIconSvg,
  splitTextIntoKnownSiteLinkSegments,
} from '../../src/ui/utils/known-site-links';
import { splitPromptIntoComposerSegments } from '../../src/ui/utils/composer-segments';

// --- extractKnownSiteLinkTokens: GitHub ---

{
  const tokens = extractKnownSiteLinkTokens('看看 https://github.com/DylanDDeng/bubble-cowork 这个项目');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].site, 'github');
  assert.equal(tokens[0].label, 'DylanDDeng/bubble-cowork');
  assert.equal(tokens[0].raw, 'https://github.com/DylanDDeng/bubble-cowork');
  assert.equal(tokens[0].url, 'https://github.com/DylanDDeng/bubble-cowork');
}

{
  // www, .git suffix, and trailing slash are all recognized; raw preserves the match.
  const cases: Array<[string, string]> = [
    ['https://www.github.com/a/b', 'a/b'],
    ['https://github.com/a/b.git', 'a/b'],
    ['https://github.com/a/b/', 'a/b'],
    ['http://github.com/a/b.js', 'a/b.js'],
  ];
  for (const [url, label] of cases) {
    const tokens = extractKnownSiteLinkTokens(url);
    assert.equal(tokens.length, 1, `should match: ${url}`);
    assert.equal(tokens[0].label, label, `label for: ${url}`);
    assert.equal(tokens[0].raw, url, `raw must equal the exact matched text: ${url}`);
  }
}

{
  // Deep repo paths (tree, blob, issues, pulls) now chip too, keeping owner/repo as label.
  const cases: Array<[string, string]> = [
    ['https://github.com/MoonshotAI/kimi-code/tree/main/packages/node-sdk', 'MoonshotAI/kimi-code'],
    ['https://github.com/a/b/issues/1', 'a/b'],
    ['https://github.com/a/b/pull/42/files', 'a/b'],
    ['https://github.com/a/b/blob/main/src/index.ts', 'a/b'],
  ];
  for (const [url, label] of cases) {
    const tokens = extractKnownSiteLinkTokens(url);
    assert.equal(tokens.length, 1, `should match: ${url}`);
    assert.equal(tokens[0].site, 'github');
    assert.equal(tokens[0].label, label, `label for: ${url}`);
    assert.equal(tokens[0].raw, url, `raw must equal the exact matched text: ${url}`);
  }
}

{
  // Reserved owners, profile-only URLs, unknown hosts, and schemeless text stay plain.
  const nonMatches = [
    'https://github.com/orgs/anthropics',
    'https://github.com/trending/typescript',
    'https://github.com/DylanDDeng',
    'https://gitlab.com/a/b',
    'github.com/a/b',
    'https://example.com/some/path',
  ];
  for (const text of nonMatches) {
    assert.equal(extractKnownSiteLinkTokens(text).length, 0, `should not match: ${text}`);
  }
}

// --- extractKnownSiteLinkTokens: X ---

{
  const cases: Array<[string, string]> = [
    ['https://x.com/karpathy', '@karpathy'],
    ['https://x.com/karpathy/status/1790000000000000000', '@karpathy'],
    ['https://twitter.com/karpathy', '@karpathy'],
    ['https://www.x.com/karpathy', '@karpathy'],
    ['https://mobile.twitter.com/karpathy/status/123/photo/1', '@karpathy'],
  ];
  for (const [url, label] of cases) {
    const tokens = extractKnownSiteLinkTokens(url);
    assert.equal(tokens.length, 1, `should match: ${url}`);
    assert.equal(tokens[0].site, 'x');
    assert.equal(tokens[0].label, label, `label for: ${url}`);
    assert.equal(tokens[0].raw, url, `raw must equal the exact matched text: ${url}`);
  }
}

{
  // Site routes and invalid handles stay plain text.
  const nonMatches = [
    'https://x.com/home',
    'https://x.com/i/flow/login',
    'https://x.com/search?q=claude',
    'https://x.com/this-handle-has-dashes',
    'https://x.com/',
  ];
  for (const text of nonMatches) {
    assert.equal(extractKnownSiteLinkTokens(text).length, 0, `should not match: ${text}`);
  }
}

// --- extractKnownSiteLinkTokens: Hugging Face ---

{
  const cases: Array<[string, string]> = [
    ['https://huggingface.co/meta-llama/Llama-3.1-8B', 'meta-llama/Llama-3.1-8B'],
    ['https://huggingface.co/Qwen/Qwen3-235B-A22B/tree/main', 'Qwen/Qwen3-235B-A22B'],
    ['https://huggingface.co/datasets/HuggingFaceFW/fineweb', 'HuggingFaceFW/fineweb'],
    ['https://huggingface.co/spaces/black-forest-labs/FLUX.1-dev', 'black-forest-labs/FLUX.1-dev'],
    ['https://hf.co/meta-llama/Llama-3.1-8B', 'meta-llama/Llama-3.1-8B'],
  ];
  for (const [url, label] of cases) {
    const tokens = extractKnownSiteLinkTokens(url);
    assert.equal(tokens.length, 1, `should match: ${url}`);
    assert.equal(tokens[0].site, 'huggingface');
    assert.equal(tokens[0].label, label, `label for: ${url}`);
    assert.equal(tokens[0].raw, url, `raw must equal the exact matched text: ${url}`);
  }
}

{
  // Site routes, profile-only URLs, and bare namespace pages stay plain text.
  const nonMatches = [
    'https://huggingface.co/docs/transformers/index',
    'https://huggingface.co/papers/2405.12345',
    'https://huggingface.co/blog/some-post',
    'https://huggingface.co/meta-llama',
    'https://huggingface.co/datasets',
    'https://huggingface.co/',
  ];
  for (const text of nonMatches) {
    assert.equal(extractKnownSiteLinkTokens(text).length, 0, `should not match: ${text}`);
  }
}

// --- delimiting and multiple tokens ---

{
  assert.equal(extractKnownSiteLinkTokens('foohttps://github.com/a/b').length, 0);
  const tokens = extractKnownSiteLinkTokens('a https://github.com/x/y b https://x.com/someone');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].start, 2);
  assert.equal(tokens[0].site, 'github');
  assert.equal(tokens[1].site, 'x');
  assert.equal(tokens[1].label, '@someone');
}

// --- icons ---

{
  assert.ok(getKnownSiteIconSvg('github')?.includes('<svg'), 'github icon exists');
  assert.ok(getKnownSiteIconSvg('x')?.includes('<svg'), 'x icon exists');
  assert.ok(getKnownSiteIconSvg('huggingface')?.includes('<svg'), 'huggingface icon exists');
  assert.equal(getKnownSiteIconSvg('unknown-site'), null);
}

// --- splitTextIntoKnownSiteLinkSegments ---

{
  const text = 'before https://github.com/a/b after';
  const segments = splitTextIntoKnownSiteLinkSegments(text, 10);
  assert.deepEqual(segments.map((s) => s.type), ['text', 'link', 'text']);
  const link = segments[1];
  assert.equal(link.type, 'link');
  if (link.type === 'link') {
    assert.equal(link.start, 17);
    assert.equal(link.end, 17 + 'https://github.com/a/b'.length);
  }
  // Roundtrip: concatenated segment text must equal the input.
  assert.equal(segments.map((s) => s.text).join(''), text);
}

// --- splitPromptIntoComposerSegments integration ---

{
  const prompt = '帮我看 https://github.com/DylanDDeng/bubble-cowork 里的 @src/main.ts 文件';
  const segments = splitPromptIntoComposerSegments(prompt);
  assert.deepEqual(
    segments.map((s) => s.type),
    ['text', 'link', 'text', 'mention', 'text']
  );
  // Serialization roundtrip guarantees the editor sends the original text.
  assert.equal(segments.map((s) => s.text).join(''), prompt);
}

{
  const prompt = '这条推 https://x.com/karpathy/status/123 和 https://github.com/a/b/tree/main 都看看';
  const segments = splitPromptIntoComposerSegments(prompt);
  assert.deepEqual(
    segments.map((s) => s.type),
    ['text', 'link', 'text', 'link', 'text']
  );
  assert.equal(segments.map((s) => s.text).join(''), prompt);
}

{
  // Prompt with no URL keeps previous behavior.
  const segments = splitPromptIntoComposerSegments('just plain text');
  assert.deepEqual(segments.map((s) => s.type), ['text']);
  assert.equal(splitPromptIntoComposerSegments('').length, 0);
}

console.log('composer-link-chip.test: all assertions passed');
