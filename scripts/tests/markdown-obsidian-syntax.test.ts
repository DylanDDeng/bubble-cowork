import assert from 'node:assert/strict';
import {
  findNoteInTree,
  headingSlug,
  isLocalMarkdownLink,
  noteLinkCandidates,
  parseCalloutHeader,
  parseTableAlignments,
  parseWikiLink,
  renderTableCellText,
  splitTableRow,
} from '../../src/ui/components/markdown-obsidian-syntax';

// Wiki links: alias, heading, and label offsets for hiding brackets.
assert.deepEqual(parseWikiLink('[[Note]]', 10), { target: 'Note', heading: '', label: 'Note', labelFrom: 12, labelTo: 16 });
assert.deepEqual(parseWikiLink('[[Note#Intro|see intro]]', 0), { target: 'Note', heading: 'Intro', label: 'see intro', labelFrom: 13, labelTo: 22 });
assert.equal(parseWikiLink('[[#Local]]', 0)?.target, '');
assert.equal(parseWikiLink('[not wiki]', 0), null);

// Callouts.
assert.deepEqual(parseCalloutHeader('> [!Warning]- Be careful'), { type: 'warning', markerFrom: 2, markerTo: 14, title: 'Be careful' });
assert.deepEqual(parseCalloutHeader('> [!tip]'), { type: 'tip', markerFrom: 2, markerTo: 8, title: '' });
assert.equal(parseCalloutHeader('> plain quote'), null);

// Tables: escaped pipes stay in the cell, offsets point at cell text.
assert.deepEqual(splitTableRow('| a | b \\| c |', 100), [{ text: 'a', from: 102 }, { text: 'b \\| c', from: 106 }]);
assert.deepEqual(splitTableRow('a | b', 0).map(cell => cell.text), ['a', 'b']);
assert.deepEqual(parseTableAlignments('| :--- | :-: | --: | --- |'), ['left', 'center', 'right', null]);
assert.equal(renderTableCellText('**bold** `code` [link](x.md) [[Note|alias]] ==hi== a \\| b'), 'bold code link alias hi a | b');

// Link resolution.
assert.equal(isLocalMarkdownLink('./guide.md'), true);
assert.equal(isLocalMarkdownLink('#heading'), false);
assert.equal(isLocalMarkdownLink('https://example.com'), false);
assert.equal(isLocalMarkdownLink('mailto:a@b.c'), false);
assert.deepEqual(noteLinkCandidates('/proj', '/proj/docs/a.md', 'Other', 'wiki'), ['/proj/docs/Other.md', '/proj/Other.md']);
assert.deepEqual(noteLinkCandidates('/proj', 'docs/a.md', '../guide%20one.md', 'markdown'), ['/proj/guide one.md']);
assert.deepEqual(noteLinkCandidates('/proj', '/proj/docs/a.md', '/notes/x', 'wiki'), ['/proj/notes/x.md']);
const tree = { name: 'proj', path: '/proj', kind: 'dir' as const, children: [
  { name: 'notes', path: '/proj/notes', kind: 'dir' as const, children: [{ name: 'Other Note.md', path: '/proj/notes/Other Note.md', kind: 'file' as const }] },
] };
assert.equal(findNoteInTree(tree, ['/proj/docs/other note.md'], 'other note', 'wiki'), '/proj/notes/Other Note.md', 'bare wiki names match anywhere, case-insensitively');
assert.equal(findNoteInTree(tree, ['/proj/docs/missing.md'], 'missing', 'wiki'), null);
assert.equal(findNoteInTree(tree, ['/proj/docs/Other Note.md'], 'Other Note.md', 'markdown'), null, 'Markdown links do not search the vault');
assert.equal(headingSlug('Section Two!'), 'section-two');
assert.equal(headingSlug('中文 标题'), '中文-标题');

console.log('markdown-obsidian-syntax: wiki links, callouts, tables and link resolution passed');
