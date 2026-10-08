import assert from 'node:assert/strict';
import { addressForDisplay, placeholderTitle, resolveAddress, webSearchUrl } from '../../src/shared/browser-address';
import { browserStatusLine, emptyAddressField, updateAddressField } from '../../src/ui/components/browser/address-bar';
import {
  absorb,
  describeLoadFailure,
  loadFailed,
  navigationStarted,
  newPage,
  retarget,
  suspend,
} from '../../src/electron/browser/browser-page';
import type { BrowserPage } from '../../src/shared/browser-types';

// ── Address resolution ───────────────────────────────────────────────────────
const search = (text: string) => webSearchUrl(text);
const cases: Array<[string, string]> = [
  ['', 'about:blank'],
  ['   ', 'about:blank'],
  ['https://Example.com', 'https://example.com/'],
  ['http://example.com/a?b=1#c', 'http://example.com/a?b=1#c'],
  ['about:blank', 'about:blank'],
  ['file:///tmp/a.html', 'file:///tmp/a.html'],
  ['localhost:3000', 'http://localhost:3000/'],
  ['localhost', 'http://localhost/'],
  ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
  ['0.0.0.0:5000', 'http://0.0.0.0:5000/'],
  ['[::1]:5173', 'http://[::1]:5173/'],
  ['example.com', 'https://example.com/'],
  ['example.com:8080/p', 'https://example.com:8080/p'],
  ['docs.my-site.dev/guide', 'https://docs.my-site.dev/guide'],
  ['192.168.1.1', 'https://192.168.1.1/'],
  ['foo', search('foo')],
  ['how to center a div', search('how to center a div')],
  ['1.2', search('1.2')],
  ['javascript:alert(1)', search('javascript:alert(1)')],
  ['chrome://settings', search('chrome://settings')],
  ['data:text/html,hi', search('data:text/html,hi')],
  ['mailto:a@b.com', search('mailto:a@b.com')],
  ['http://', search('http://')],
];
for (const [typed, expected] of cases) {
  assert.equal(resolveAddress(typed), expected, JSON.stringify(typed));
}
assert.equal(addressForDisplay('about:blank'), '');
assert.equal(addressForDisplay(' https://a.dev/ '), 'https://a.dev/');
assert.equal(addressForDisplay(null), '');
assert.equal(placeholderTitle('about:blank'), 'New page');
assert.equal(placeholderTitle('https://news.example.com/today'), 'news.example.com');
assert.equal(placeholderTitle('file:///tmp/a.html'), 'file:///tmp/a.html');

// ── Page model ───────────────────────────────────────────────────────────────
const page: BrowserPage = newPage('https://a.dev/');
assert.equal(page.phase, 'suspended');
assert.equal(page.title, 'a.dev');
assert.match(page.id, /^[0-9a-f-]{36}$/);

navigationStarted(page);
assert.deepEqual([page.phase, page.loading, page.error], ['live', true, null]);
absorb(page, { url: 'https://a.dev/home', title: 'Home', loading: false, canBack: true, canForward: false, favicons: ['https://a.dev/f.ico'] });
assert.deepEqual(
  [page.url, page.committedUrl, page.title, page.loading, page.canBack, page.favicon],
  ['https://a.dev/home', 'https://a.dev/home', 'Home', false, true, 'https://a.dev/f.ico']
);
// No favicon in a report keeps the last one; an empty title falls back to the host.
absorb(page, { url: 'https://a.dev/next', title: '', loading: true, canBack: true, canForward: false });
assert.equal(page.favicon, 'https://a.dev/f.ico');
assert.equal(page.title, 'a.dev');

// A failed load keeps its message through the reports that follow, until the next navigation.
loadFailed(page, describeLoadFailure(-102), 'http://127.0.0.1:1/');
assert.equal(page.error, 'Connection refused.');
assert.equal(page.url, 'http://127.0.0.1:1/');
absorb(page, { url: '', title: '', loading: false, canBack: true, canForward: false });
assert.equal(page.error, 'Connection refused.', 'did-stop-loading must not wipe the failure');
assert.equal(page.url, 'http://127.0.0.1:1/', 'an empty view URL keeps the page address');
navigationStarted(page);
assert.equal(page.error, null);
assert.equal(describeLoadFailure(-105), "Couldn't resolve this address.");
assert.equal(describeLoadFailure(-999), "Couldn't open this page.");

retarget(page, 'https://b.dev/');
assert.deepEqual([page.url, page.title, page.committedUrl, page.error], ['https://b.dev/', 'b.dev', null, null]);
suspend(page);
assert.deepEqual([page.phase, page.loading, page.canBack, page.canForward], ['suspended', false, false, false]);
assert.equal(page.url, 'https://b.dev/', 'a suspended page keeps its address');

// ── Address field ────────────────────────────────────────────────────────────
const pageA = { ...newPage('https://a.dev/'), id: 'A' };
const pageB = { ...newPage('about:blank'), id: 'B' };
let field = updateAddressField(emptyAddressField, { kind: 'page', page: pageA });
assert.deepEqual([field.text, field.editing], ['https://a.dev/', false]);
field = updateAddressField(field, { kind: 'type', text: 'news' });
// A redirect while typing does not overwrite the typed text...
field = updateAddressField(field, { kind: 'page', page: { ...pageA, url: 'https://a.dev/redirected' } });
assert.equal(field.text, 'news');
// ...Escape restores the latest page address...
field = updateAddressField(field, { kind: 'cancel' });
assert.deepEqual([field.text, field.editing], ['https://a.dev/redirected', false]);
// ...and when not editing, the field follows the page.
field = updateAddressField(field, { kind: 'page', page: { ...pageA, url: 'https://a.dev/later' } });
assert.equal(field.text, 'https://a.dev/later');
// A different page always shows its own address, even mid-edit; a blank page shows nothing.
field = updateAddressField(updateAddressField(field, { kind: 'type', text: 'half' }), { kind: 'page', page: pageB });
assert.deepEqual([field.text, field.editing], ['', false]);
field = updateAddressField(field, { kind: 'focus' });
assert.equal(field.editing, true);
field = updateAddressField(field, { kind: 'submitted' });
assert.equal(field.editing, false);
// Submitting shows the page address even if the navigation's push came in mid-edit.
let racing = updateAddressField(updateAddressField(emptyAddressField, { kind: 'page', page: pageA }), { kind: 'type', text: 'b.dev' });
racing = updateAddressField(racing, { kind: 'page', page: { ...pageA, url: 'https://b.dev/' } });
assert.equal(racing.text, 'b.dev');
racing = updateAddressField(racing, { kind: 'submitted' });
assert.deepEqual([racing.text, racing.editing], ['https://b.dev/', false]);
const same = updateAddressField(field, { kind: 'page', page: pageB });
assert.equal(same, field, 'an unchanged page keeps the same field object');

// ── Status line ──────────────────────────────────────────────────────────────
assert.deepEqual(browserStatusLine({ localError: 'Bad', page: { ...pageA, error: 'Other' }, open: true }), { text: 'Bad', tone: 'error' });
assert.deepEqual(browserStatusLine({ localError: null, page: { ...pageA, error: 'Other' }, open: true }), { text: 'Other', tone: 'error' });
assert.deepEqual(browserStatusLine({ localError: null, page: null, open: true }), { text: 'No page open', tone: 'info' });
assert.deepEqual(browserStatusLine({ localError: null, page: null, open: false }), { text: 'Starting browser...', tone: 'info' });
assert.deepEqual(browserStatusLine({ localError: null, page: pageA, open: true }), { text: 'Restoring page...', tone: 'info' });
assert.equal(browserStatusLine({ localError: null, page: { ...pageA, phase: 'live' }, open: true }), null);

console.log('browser-model.test.ts passed');
