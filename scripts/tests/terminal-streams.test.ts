import assert from 'node:assert/strict';
import {
  isTerminalReport,
  OutputQueue,
  SizeSync,
  splitInput,
  type Clock,
} from '../../src/ui/terminal/terminal-streams';

class FakeClock implements Clock {
  time = 0;
  private seq = 0;
  private frames = new Map<number, () => void>();
  private timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  frame = (run: () => void) => {
    const id = ++this.seq;
    this.frames.set(id, run);
    return id;
  };
  cancelFrame = (id: number) => void this.frames.delete(id);
  delay = (run: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  };
  cancelDelay = (id: number) => void this.timers.delete(id);
  paint() {
    const due = [...this.frames.values()];
    this.frames.clear();
    due.forEach((run) => run());
  }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.timers.delete(id)) timer.run();
    }
  }
  get scheduled() {
    return this.frames.size + this.timers.size;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── OutputQueue ──────────────────────────────────────────────────────────────
{
  const clock = new FakeClock();
  const written: string[] = [];
  const queue = new OutputQueue((data) => written.push(data), clock, { burst: 10, maxLatencyMs: 50, heldTail: 20 });

  // On screen: chunks wait for the next frame and go out as one write.
  queue.setOnScreen(true);
  queue.push('ab');
  queue.push('cd');
  assert.deepEqual(written, []);
  clock.paint();
  assert.deepEqual(written, ['abcd']);
  assert.equal(clock.scheduled, 0, 'a drained queue keeps no timers');

  // No frame (window in the background): the latency cap still drains.
  queue.push('ef');
  clock.advance(50);
  assert.deepEqual(written, ['abcd', 'ef']);

  // A burst over the limit is written immediately.
  queue.push('0123456789');
  assert.deepEqual(written.at(-1), '0123456789');

  // Off screen: held in order, released when shown again.
  queue.setOnScreen(false);
  queue.push('gh');
  queue.push('ij');
  clock.paint();
  clock.advance(100);
  assert.equal(written.length, 3, "nothing is written while off screen");
  queue.setOnScreen(true);
  assert.deepEqual(written.at(-1), 'ghij');

  // Held output keeps a bounded tail, starting at a line when one is near.
  queue.setOnScreen(false);
  queue.push('old line one\nold two\n');
  queue.push('new line\n');
  assert.ok(queue.pending <= 20 + 8);
  queue.setOnScreen(true);
  const tail = written.at(-1)!;
  assert.ok(tail.startsWith('\x1b[0m'), 'the kept tail resets attributes first');
  assert.ok(tail.endsWith('new line\n'));
  assert.ok(!tail.includes('old line one'));

  // Discard drops everything without writing.
  queue.push('gone');
  queue.discard();
  clock.paint();
  clock.advance(100);
  assert.ok(!written.includes('gone'));
}

// ── SizeSync ─────────────────────────────────────────────────────────────────
const sizeSync = (async () => {
  const clock = new FakeClock();
  const sent: string[] = [];
  let accept = true;
  let connected = true;
  const sync = new SizeSync(
    async (size) => {
      sent.push(`${size.cols}x${size.rows}`);
      return accept;
    },
    () => connected,
    clock,
    120
  );

  // Debounced: only the last size in a burst is sent.
  sync.request({ cols: 80, rows: 24 });
  sync.request({ cols: 90, rows: 24 });
  clock.advance(119);
  assert.deepEqual(sent, []);
  clock.advance(1);
  assert.deepEqual(sent, ['90x24']);
  await flush();

  // The size the backend already has is not sent again.
  sync.request({ cols: 90, rows: 24 });
  clock.advance(200);
  assert.deepEqual(sent, ['90x24']);

  // A refused size is forgotten, so asking again resends it.
  accept = false;
  sync.request({ cols: 100, rows: 30 });
  clock.advance(120);
  await flush();
  accept = true;
  sync.request({ cols: 100, rows: 30 });
  clock.advance(120);
  assert.deepEqual(sent, ['90x24', '100x30', '100x30']);
  await flush();

  // Nothing is sent while there is no backend session.
  connected = false;
  sync.request({ cols: 120, rows: 40 });
  clock.advance(120);
  assert.equal(sent.length, 3);

  // Reset forgets the acknowledged size.
  connected = true;
  sync.reset();
  sync.request({ cols: 100, rows: 30 });
  clock.advance(120);
  assert.deepEqual(sent.at(-1), '100x30');
  assert.equal(sent.length, 4);
})();

// ── Input ────────────────────────────────────────────────────────────────────
for (const report of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[?6c', '\x1b[?2004h', '\x1b[?2004l']) {
  assert.equal(isTerminalReport(report), true, JSON.stringify(report));
}
assert.equal(isTerminalReport('\x1b[A'), false);
assert.equal(isTerminalReport('ls\r'), false);
assert.equal(isTerminalReport('x\x1b[I'), false, 'only whole reports are dropped');

assert.deepEqual(splitInput('', 4), []);
assert.deepEqual(splitInput('abc', 4), ['abc']);
assert.deepEqual(splitInput('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
const emoji = 'ab😀cd';
const pieces = splitInput(emoji, 3);
assert.equal(pieces.join(''), emoji);
assert.ok(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece)), 'a surrogate pair is never split');
const paste = 'x'.repeat(150_000);
assert.equal(splitInput(paste, 64_000).length, 3);
assert.equal(splitInput(paste, 64_000).join(''), paste);

sizeSync.then(
  () => console.log('terminal-streams.test.ts passed'),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
