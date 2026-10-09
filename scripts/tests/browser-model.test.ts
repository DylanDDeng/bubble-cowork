import assert from 'node:assert/strict';
import { addressForDisplay, placeholderTitle, resolveAddress, webSearchUrl } from '../../src/shared/browser-address';
import {
  browserStatusLine,
  emptyAddressField,
  pageOverlayFor,
  panelShortcutFor,
  recentPages,
  siteMarkFor,
  updateAddressField,
} from '../../src/ui/components/browser/address-bar';
import { browserShortcutFor, nextZoom } from '../../src/electron/browser/shortcuts';
import { agentBrowserRevealDecision } from '../../src/ui/utils/agent-browser-reveal';
import {
  absorb,
  describeLoadFailure,
  loadFailed,
  navigationStarted,
  newPage,
  retarget,
  suspend,
} from '../../src/electron/browser/browser-page';
import {
  browserPermissionRule,
  PermissionGrants,
  permissionKinds,
  permissionOrigin,
  permissionQuestion,
  permissionSite,
} from '../../src/electron/browser/permission-policy';
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
// Load errors get the error view, not the status line.
assert.equal(browserStatusLine({ localError: null, page: { ...pageA, error: 'Other' }, open: true }), null);
assert.deepEqual(browserStatusLine({ localError: null, page: null, open: true }), { text: 'No page open', tone: 'info' });
assert.deepEqual(browserStatusLine({ localError: null, page: null, open: false }), { text: 'Starting browser...', tone: 'info' });
assert.deepEqual(browserStatusLine({ localError: null, page: pageA, open: true }), { text: 'Restoring page...', tone: 'info' });
assert.equal(browserStatusLine({ localError: null, page: { ...pageA, phase: 'live' }, open: true }), null);

// ── Page permissions ─────────────────────────────────────────────────────────
assert.equal(browserPermissionRule('clipboard-sanitized-write'), 'allow');
assert.equal(browserPermissionRule('fullscreen'), 'allow');
for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) {
  assert.equal(browserPermissionRule(permission), 'ask', permission);
}
for (const permission of ['midi', 'midiSysex', 'hid', 'serial', 'usb', 'display-capture', 'idle-detection', 'unknown']) {
  assert.equal(browserPermissionRule(permission), 'deny', permission);
}
assert.deepEqual(permissionKinds('media', ['video']), ['media:video']);
assert.deepEqual(permissionKinds('media', ['audio', 'video']), ['media:audio', 'media:video']);
assert.deepEqual(permissionKinds('media', []), ['media:video', 'media:audio']);
assert.deepEqual(permissionKinds('geolocation'), ['geolocation']);
assert.equal(permissionSite('http://localhost:5173/app'), 'localhost:5173');
assert.equal(permissionSite('file:///tmp/a.html'), 'A local file');
assert.equal(permissionOrigin('https://meet.example/room?x=1'), 'https://meet.example');
assert.equal(
  permissionQuestion('meet.example', ['media:video', 'media:audio']),
  'meet.example wants to use your camera and your microphone.'
);
assert.equal(permissionQuestion('maps.example', ['geolocation']), 'maps.example wants to use your location.');
assert.equal(permissionQuestion('news.example', ['notifications']), 'news.example wants to show notifications.');
assert.match(permissionQuestion('a.example', ['openExternal'], 'zoommtg://join'), /open a link in another app \(zoommtg:\/\/join\)/);
const grants = new PermissionGrants();
assert.equal(grants.answer('https://meet.example', ['media:video']), undefined);
grants.record('https://meet.example', ['media:video'], true);
assert.equal(grants.answer('https://meet.example', ['media:video']), true);
assert.equal(grants.answer('https://meet.example', ['media:video', 'media:audio']), undefined, 'a new capability asks again');
grants.record('https://meet.example', ['media:audio'], false);
assert.equal(grants.answer('https://meet.example', ['media:video', 'media:audio']), false);
assert.equal(grants.answer('https://other.example', ['media:video']), undefined, 'answers stay with their site');

// ── Page overlays, site mark, recent pages ───────────────────────────────────
const live = { ...pageA, phase: 'live' as const };
assert.equal(pageOverlayFor(null, false), null);
assert.equal(pageOverlayFor({ ...live, url: 'about:blank' }, false), 'empty');
assert.equal(pageOverlayFor({ ...live, url: 'about:blank' }, true), null, 'an agent driving a blank page keeps it visible');
assert.equal(pageOverlayFor({ ...live, error: 'Connection refused.' }, false), 'error');
assert.equal(pageOverlayFor({ ...live, error: 'Connection refused.', loading: true }, false), null, 'a retry in progress shows the page');
assert.equal(pageOverlayFor(live, false), null);
assert.equal(siteMarkFor(null), 'search');
assert.equal(siteMarkFor({ ...live, url: 'about:blank' }), 'search');
assert.equal(siteMarkFor({ ...live, error: 'x' }), 'error');
assert.equal(siteMarkFor({ ...live, url: 'file:///tmp/a.html' }), 'file');
assert.equal(siteMarkFor({ ...live, favicon: 'https://a.dev/favicon.ico' }), 'favicon');
assert.equal(siteMarkFor({ ...live, favicon: 'javascript:alert(1)' }), 'web', 'only http(s) and image data favicons render');
const remembered = {
  self: { pageId: '1', url: 'https://self.dev/', title: 'Self', favicon: null, seenAt: 9 },
  a: { pageId: '2', url: 'https://a.dev/', title: 'A', favicon: null, seenAt: 3 },
  b: { pageId: '3', url: 'https://b.dev/', title: 'B', favicon: 'https://b.dev/f.ico', seenAt: 5 },
  dupe: { pageId: '4', url: 'https://a.dev/', title: 'A again', favicon: null, seenAt: 1 },
  blank: { pageId: '5', url: 'about:blank', title: '', favicon: null, seenAt: 8 },
};
assert.deepEqual(recentPages(remembered, 'self').map((p) => p.url), ['https://b.dev/', 'https://a.dev/']);

// ── Keyboard: page shortcuts (main) and panel shortcuts (renderer) ───────────
const key = (code: string, mods: Partial<Record<'meta' | 'control' | 'shift' | 'alt', boolean>> = {}, key = '') => ({
  type: 'keyDown', code, key, meta: false, control: false, shift: false, alt: false, ...mods,
});
assert.equal(browserShortcutFor(key('KeyL', { meta: true }), true), 'focus-address');
assert.equal(browserShortcutFor(key('KeyR', { meta: true }), true), 'reload');
assert.equal(browserShortcutFor(key('KeyR', { meta: true, shift: true }), true), 'hard-reload');
assert.equal(browserShortcutFor(key('BracketLeft', { meta: true }), true), 'back');
assert.equal(browserShortcutFor(key('BracketRight', { meta: true }), true), 'forward');
assert.equal(browserShortcutFor(key('KeyF', { meta: true }), true), 'find');
assert.equal(browserShortcutFor(key('Equal', { meta: true }), true), 'zoom-in');
assert.equal(browserShortcutFor(key('Minus', { meta: true }), true), 'zoom-out');
assert.equal(browserShortcutFor(key('Digit0', { meta: true }), true), 'zoom-reset');
assert.equal(browserShortcutFor(key('KeyR', { control: true }), false), 'reload', 'Ctrl on Windows/Linux');
assert.equal(browserShortcutFor(key('KeyR', { control: true }), true), null, 'Ctrl+R is not a Mac shortcut');
assert.equal(browserShortcutFor(key('KeyC', { meta: true }), true), null, 'copy stays with the page');
assert.equal(browserShortcutFor(key('KeyL'), true), null, 'plain typing stays with the page');
assert.equal(browserShortcutFor({ ...key('KeyL', { meta: true }), type: 'keyUp' }, true), null);
assert.equal(nextZoom(1, 'in'), 1.1);
assert.equal(nextZoom(1, 'out'), 0.9);
assert.equal(nextZoom(1.33, 'reset'), 1);
assert.equal(nextZoom(5, 'in'), 5, 'clamped at the top step');
assert.equal(nextZoom(1.05, 'in'), 1.1, 'off-ladder zoom moves to the next step');
const panelKey = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  code, key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods,
});
assert.equal(panelShortcutFor(panelKey('KeyL', { metaKey: true }), true), 'focus-address');
assert.equal(panelShortcutFor(panelKey('KeyF', { metaKey: true }), true), 'find');
assert.equal(panelShortcutFor(panelKey('BracketLeft', { metaKey: true }), true), 'back');
assert.equal(panelShortcutFor(panelKey('KeyF', { metaKey: true, shiftKey: true }), true), null);
assert.equal(panelShortcutFor(panelKey('KeyR', { metaKey: true }), true), null, 'Reload/Zoom go through the app menu');

// ── Agent browser actions: reveal, notify or stay quiet ──────────────────────
const reveal = (input: Partial<Parameters<typeof agentBrowserRevealDecision>[0]>) =>
  agentBrowserRevealDecision({ sessionId: 's1', activeSessionId: 's1', browserTabShown: false, settingsOpen: false, now: 0, ...input });
assert.equal(reveal({ now: 1000 }), 'reveal', 'the current task shows its browser');
assert.equal(reveal({ now: 2000 }), 'none', 'not again right after the user moved away');
assert.equal(reveal({ now: 2000 + 91_000 }), 'reveal', 'after a quiet while it shows again');
assert.equal(reveal({ sessionId: 's2', now: 5000 }), 'notify', 'another task only gets a notice');
assert.equal(reveal({ sessionId: 's2', now: 6000 }), 'none', 'at most one notice a minute per task');
assert.equal(reveal({ sessionId: 's3', settingsOpen: true, now: 7000 }), 'notify', 'never pulls the user out of Settings');

console.log('browser-model.test.ts passed');
