import assert from 'node:assert/strict';
import {
  extractGitHubRepoTokens,
  splitTextIntoGitHubRepoSegments,
} from '../../src/ui/utils/github-repo-links';
import { splitPromptIntoComposerSegments } from '../../src/ui/utils/composer-segments';

// --- extractGitHubRepoTokens ---

{
  const tokens = extractGitHubRepoTokens('看看 https://github.com/DylanDDeng/bubble-cowork 这个项目');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].owner, 'DylanDDeng');
  assert.equal(tokens[0].repo, 'bubble-cowork');
  assert.equal(tokens[0].raw, 'https://github.com/DylanDDeng/bubble-cowork');
  assert.equal(tokens[0].url, 'https://github.com/DylanDDeng/bubble-cowork');
}

{
  // www, .git suffix, and trailing slash are all recognized; raw preserves the match.
  const cases: Array<[string, string]> = [
    ['https://www.github.com/a/b', 'b'],
    ['https://github.com/a/b.git', 'b'],
    ['https://github.com/a/b/', 'b'],
    ['http://github.com/a/b.js', 'b.js'],
  ];
  for (const [url, repo] of cases) {
    const tokens = extractGitHubRepoTokens(url);
    assert.equal(tokens.length, 1, `should match: ${url}`);
    assert.equal(tokens[0].repo, repo, `repo name for: ${url}`);
    assert.equal(tokens[0].raw, url, `raw must equal the exact matched text: ${url}`);
  }
}

{
  // Deeper paths, reserved owners, and non-GitHub URLs stay plain text.
  const nonMatches = [
    'https://github.com/a/b/issues/1',
    'https://github.com/a/b/tree/main',
    'https://github.com/orgs/anthropics',
    'https://github.com/DylanDDeng',
    'https://gitlab.com/a/b',
    'github.com/a/b',
  ];
  for (const text of nonMatches) {
    assert.equal(extractGitHubRepoTokens(text).length, 0, `should not match: ${text}`);
  }
}

{
  // Must be delimited by whitespace or string boundaries.
  assert.equal(extractGitHubRepoTokens('foohttps://github.com/a/b').length, 0);
  const tokens = extractGitHubRepoTokens('a https://github.com/x/y b https://github.com/m/n');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].start, 2);
  assert.equal(tokens[1].repo, 'n');
}

// --- splitTextIntoGitHubRepoSegments ---

{
  const text = 'before https://github.com/a/b after';
  const segments = splitTextIntoGitHubRepoSegments(text, 10);
  assert.deepEqual(segments.map((s) => s.type), ['text', 'repo', 'text']);
  const repo = segments[1];
  assert.equal(repo.type, 'repo');
  if (repo.type === 'repo') {
    assert.equal(repo.start, 17);
    assert.equal(repo.end, 17 + 'https://github.com/a/b'.length);
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
    ['text', 'repo', 'text', 'mention', 'text']
  );
  // Serialization roundtrip guarantees the editor sends the original text.
  assert.equal(segments.map((s) => s.text).join(''), prompt);
}

{
  // Prompt with no URL keeps previous behavior.
  const segments = splitPromptIntoComposerSegments('just plain text');
  assert.deepEqual(segments.map((s) => s.type), ['text']);
  assert.equal(splitPromptIntoComposerSegments('').length, 0);
}

console.log('composer-repo-chip.test: all assertions passed');
