import assert from 'node:assert/strict';
import {
  EXCERPT_LENGTH,
  excerptAround,
  formatAge,
  isEmptyResult,
  markQueryWords,
  searchActions,
  searchPalette,
  searchProjects,
  searchThreads,
  threadHitLabel,
  type PaletteAction,
  type PaletteProject,
  type PaletteThread,
} from '../../src/ui/components/search/palette-ranking';

const actions: PaletteAction[] = [
  { id: 'new-thread', label: 'New Task', description: 'Start a new conversation', keywords: ['create', 'chat'], shortcut: '⌘N' },
  { id: 'open-project', label: 'Open Project Folder', description: 'Pick a working directory', keywords: ['folder', 'cwd'] },
  { id: 'settings', label: 'Settings', description: 'Open application settings', keywords: ['preferences'] },
];

// Actions: every action for an empty query, in input order.
assert.deepEqual(searchActions(actions, '').map((a) => a.id), ['new-thread', 'open-project', 'settings']);
assert.deepEqual(searchActions(actions, '   ').map((a) => a.id), ['new-thread', 'open-project', 'settings']);
// Label beats keyword beats description; queries fold case and spacing.
assert.deepEqual(searchActions(actions, 'SETTINGS').map((a) => a.id), ['settings']);
assert.deepEqual(searchActions(actions, 'open').map((a) => a.id), ['open-project', 'settings']);
assert.deepEqual(searchActions(actions, 'folder').map((a) => a.id), ['open-project']);
assert.deepEqual(searchActions(actions, 'conversation').map((a) => a.id), ['new-thread']);
assert.deepEqual(searchActions(actions, 'nothing like this'), []);

const projects: PaletteProject[] = [
  { id: '/w/aegis', name: 'aegis', cwd: '/w/aegis', sessionCount: 3, lastUpdatedAt: 10 },
  { id: '/w/aegis-site', name: 'aegis-site', cwd: '/w/aegis-site', sessionCount: 1, lastUpdatedAt: 50 },
  { id: '/w/my-aegis', name: 'my-aegis', cwd: '/w/my-aegis', sessionCount: 1, lastUpdatedAt: 99 },
  { id: '/srv/aegis-ops/tools', name: 'tools', cwd: '/srv/aegis-ops/tools', sessionCount: 2, lastUpdatedAt: 5 },
  { id: '/w/beta', name: 'beta', cwd: '/w/beta', sessionCount: 1, lastUpdatedAt: 1 },
];

// Projects: nothing until the user types; name grades outrank a path hit.
assert.deepEqual(searchProjects(projects, ''), []);
assert.deepEqual(searchProjects(projects, 'aegis').map((p) => p.name), ['aegis', 'aegis-site', 'my-aegis', 'tools']);
// Equal grades fall back to recency, then name.
const twins: PaletteProject[] = [
  { id: 'b', name: 'beta-two', cwd: '/b', sessionCount: 1, lastUpdatedAt: 7 },
  { id: 'a', name: 'beta-one', cwd: '/a', sessionCount: 1, lastUpdatedAt: 7 },
  { id: 'c', name: 'beta-new', cwd: '/c', sessionCount: 1, lastUpdatedAt: 9 },
];
assert.deepEqual(searchProjects(twins, 'beta').map((p) => p.id), ['c', 'a', 'b']);
assert.equal(searchProjects(Array.from({ length: 10 }, (_, i) => ({ ...projects[0], id: `p${i}` })), 'aegis').length, 6);

const thread = (id: string, title: string, updatedAt: number, texts: string[] = [], projectName = 'aegis'): PaletteThread => ({
  id,
  title,
  projectName,
  updatedAt,
  texts,
});

// Threads: an empty query lists the five most recent.
const many = Array.from({ length: 7 }, (_, i) => thread(`t${i}`, `Thread ${i}`, i));
assert.deepEqual(searchThreads(many, '').map((h) => h.thread.id), ['t6', 't5', 't4', 't3', 't2']);
assert.ok(searchThreads(many, '').every((h) => h.source === 'title' && h.excerpt === null && h.messageHits === 0));

const threads = [
  thread('title-exact', 'retry helper', 1),
  thread('title-lead', 'retry helper for http', 2),
  thread('message-exact', 'Unrelated', 3, ['Retry helper']),
  thread('message-any', 'Other', 4, ['we added a retry helper yesterday', 'and the retry helper again']),
  thread('words', 'Words', 5, ['helper that does a retry']),
  thread('project', 'Nothing', 6, [], 'retry helper tools'),
  thread('miss', 'Nope', 7, ['completely different']),
];
const hits = searchThreads(threads, 'Retry  Helper');
assert.deepEqual(
  hits.map((h) => [h.thread.id, h.source]),
  [
    ['title-exact', 'title'],
    ['message-exact', 'message'],
    // Both weigh 145 (title leads / message contains): the newer thread wins.
    ['message-any', 'message'],
    ['title-lead', 'title'],
    ['words', 'message'],
    ['project', 'project'],
  ]
);
assert.equal(hits.find((h) => h.thread.id === 'message-any')!.messageHits, 2);
assert.equal(hits.find((h) => h.thread.id === 'message-any')!.excerpt, 'we added a retry helper yesterday');
// A title hit keeps its title source even when a message matches better.
const titleFirst = searchThreads([thread('x', 'my retry helper', 1, ['retry helper'])], 'retry helper')[0];
assert.equal(titleFirst.source, 'title');
assert.equal(titleFirst.messageHits, 1);
// Ties: newer first, then the shorter title.
assert.deepEqual(
  searchThreads([thread('long', 'notes about deploy', 5), thread('short', 'deploy notes', 5), thread('new', 'deploy', 9)], 'deploy').map((h) => h.thread.id),
  ['new', 'short', 'long']
);
assert.equal(searchThreads(Array.from({ length: 12 }, (_, i) => thread(`n${i}`, 'deploy', i)), 'deploy').length, 8);
// Re-searching after a thread's text changes uses the new text.
const live = thread('live', 'Live', 1, ['first draft']);
assert.equal(searchThreads([live], 'second').length, 0);
assert.equal(searchThreads([{ ...live, texts: ['first draft', 'second draft'] }], 'second').length, 1);

// Excerpts: short text as is; long text windows the match with a lead-in.
assert.equal(excerptAround('  short   text ', 'short'), 'short text');
const long = `${'a'.repeat(100)} the needle sits here ${'b'.repeat(100)}`;
const excerpt = excerptAround(long, 'needle');
assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'));
assert.ok(excerpt.includes('the needle sits here'));
assert.ok(excerpt.length <= EXCERPT_LENGTH + 2);
assert.ok(excerptAround(`needle ${'c'.repeat(200)}`, 'needle').startsWith('needle'));
assert.ok(excerptAround(`${'d'.repeat(200)} needle`, 'needle').endsWith('needle'));
// Phrase absent: anchor on the earliest word.
assert.ok(excerptAround(`${'e'.repeat(150)} beta ${'f'.repeat(20)} alpha`, 'alpha beta').includes('beta'));

// Highlighting marks each query word, longest first, case-insensitively.
assert.deepEqual(markQueryWords('Retry the retry-helper', 'retry'), [
  { text: 'Retry', marked: true },
  { text: ' the ', marked: false },
  { text: 'retry', marked: true },
  { text: '-helper', marked: false },
]);
assert.deepEqual(markQueryWords('helper', 'help helper'), [{ text: 'helper', marked: true }]);
assert.deepEqual(markQueryWords('plain', ''), [{ text: 'plain', marked: false }]);
assert.deepEqual(markQueryWords('', 'x'), []);

// Ages.
const now = Date.UTC(2026, 9, 7, 12);
assert.equal(formatAge(undefined, now), '');
assert.equal(formatAge(now - 10_000, now), '1m');
assert.equal(formatAge(now - 45 * 60_000, now), '45m');
assert.equal(formatAge(now - 5 * 3_600_000, now), '5h');
assert.equal(formatAge(now - 3 * 86_400_000, now), '3d');
assert.notEqual(formatAge(now - 30 * 86_400_000, now).match(/\d/), null);

// Labels.
assert.equal(threadHitLabel({ source: 'message', messageHits: 3 }), '3 chat hits');
assert.equal(threadHitLabel({ source: 'message', messageHits: 1 }), 'Chat match');
assert.equal(threadHitLabel({ source: 'project', messageHits: 0 }), 'Project match');
assert.equal(threadHitLabel({ source: 'title', messageHits: 4 }), null);

// Whole palette.
assert.equal(isEmptyResult(searchPalette({ actions, projects, threads }, 'zzz-no-match')), true);
const all = searchPalette({ actions, projects, threads }, '');
assert.equal(all.actions.length, 3);
assert.equal(all.projects.length, 0);
assert.equal(all.threads.length, 5);

console.log('palette-ranking.test.ts passed');
