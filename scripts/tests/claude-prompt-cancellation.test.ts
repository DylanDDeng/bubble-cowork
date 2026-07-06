import assert from 'node:assert/strict';
import { createPromptCancellation } from '../../src/electron/libs/claude-prompt-cancellation';

/**
 * Behavioral test of the runner's prompt-enqueue cancellation mechanics,
 * mirroring runner.ts's serial chain shape: each enqueue link checks
 * isCancelled at entry, races its long prepare step against cancellation,
 * re-checks before pushing, and settles in finally.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

void (async () => {
  // Uncancelled work flows through the race untouched.
  {
    const pc = createPromptCancellation();
    const seq = pc.issueSeq();
    assert.equal(await pc.race(Promise.resolve('msg')), 'msg', 'race passes work through');
    pc.settle(seq);
    assert.equal(pc.cancelPending(), 0, 'nothing pending once settled');
  }

  // THE round-5 scenario: stop lands while a prompt is mid-prepare (parked on
  // an attachment read). The cancelled link must release the serial chain
  // immediately — the user's resend must not wait on the stopped work — and
  // the abandoned prepare finishing later must not push retroactively.
  {
    const pc = createPromptCancellation();
    let chain: Promise<void> = Promise.resolve();
    const pushed: string[] = [];
    let releaseSlowRead: (value: string) => void = () => {};
    const slowRead = new Promise<string>((resolve) => {
      releaseSlowRead = resolve;
    });

    const enqueue = (work: Promise<string>, label: string) => {
      const seq = pc.issueSeq();
      chain = chain
        .then(async () => {
          if (pc.isCancelled(seq)) return;
          const message = await pc.race(work);
          if (message === null || pc.isCancelled(seq)) return;
          pushed.push(`${label}:${message}`);
        })
        .finally(() => pc.settle(seq));
    };

    enqueue(slowRead, 'A');
    await tick(); // A is now parked inside race(slowRead)
    assert.equal(pc.cancelPending(), 1, 'the preparing prompt counts as pending');

    enqueue(Promise.resolve('ok'), 'B'); // the user's immediate resend

    const outcome = await Promise.race([
      chain.then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(resolve, 2_000, 'timeout')),
    ]);
    assert.equal(outcome, 'done', 'chain settles promptly — resend never waits on cancelled work');
    assert.deepEqual(pushed, ['B:ok'], 'the resend pushed; the cancelled prompt never did');

    releaseSlowRead('late');
    await tick();
    assert.deepEqual(pushed, ['B:ok'], 'the abandoned prepare must not push retroactively');
    assert.equal(pc.cancelPending(), 0, 'everything settled; a fresh stop cancels nothing');
  }

  // Cancellation lands BEFORE the link starts: the entry watermark check
  // catches it without ever entering the race.
  {
    const pc = createPromptCancellation();
    const seq = pc.issueSeq();
    assert.equal(pc.cancelPending(), 1);
    assert.equal(pc.isCancelled(seq), true, 'issued-before-cancel is cancelled');
  }

  // An abandoned prepare that eventually REJECTS must be swallowed — an
  // unhandled rejection here would crash the process (node exits non-zero).
  {
    const pc = createPromptCancellation();
    let rejectRead: (error: Error) => void = () => {};
    const doomedRead = new Promise<string>((_resolve, reject) => {
      rejectRead = reject;
    });
    pc.issueSeq();
    const raced = pc.race(doomedRead);
    pc.cancelPending();
    assert.equal(await raced, null, 'cancellation wins the race');
    rejectRead(new Error('attachment read failed after cancel'));
    await tick();
  }

  // Prompts issued AFTER a cancellation get a fresh signal: they are not
  // retro-cancelled, and a SECOND stop cancels and releases them too.
  {
    const pc = createPromptCancellation();
    pc.issueSeq();
    pc.cancelPending();
    const seq2 = pc.issueSeq();
    assert.equal(pc.isCancelled(seq2), false, 'new sends are not retro-cancelled');
    const raced = pc.race(new Promise<string>(() => {}));
    assert.equal(pc.cancelPending(), 1, 'second stop cancels the new pending prompt');
    assert.equal(await raced, null, 'second stop releases the new in-flight race');
  }

  console.log('claude-prompt-cancellation.test: all assertions passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
