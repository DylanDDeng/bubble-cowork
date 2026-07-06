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

  // Cancellation lands during the model round-trip — which, since the
  // zero-turn stop path leaves the warm runner with NO fallback armed, must
  // release the chain even if the control request NEVER resolves (a wedged
  // CLI): the follow-up send queued behind it would otherwise hang with no
  // recovery. Mirrors runner.ts: the switch is raced, a cancelled link
  // bails, and the late completion still records the model bookkeeping —
  // unless a newer link claimed the model since (epoch guard).
  {
    const pc = createPromptCancellation();
    let chain: Promise<void> = Promise.resolve();
    let buildStarted = false;
    const ran: string[] = [];
    let currentModel = 'model-a';
    let modelSwitchEpoch = 0;
    let releaseModelSwitch: () => void = () => {};
    const wedgedSwitch = new Promise<void>((resolve) => {
      releaseModelSwitch = resolve;
    });

    const enqueueWithSwitch = (targetModel: string, switchWork: Promise<void>, label: string) => {
      const seq = pc.issueSeq();
      chain = chain
        .then(async () => {
          if (pc.isCancelled(seq)) return;
          if (targetModel !== currentModel) {
            const switchEpoch = ++modelSwitchEpoch;
            const switched = await pc.race(switchWork.then(() => true as const));
            if (switched === null) {
              void switchWork.then(
                () => {
                  if (modelSwitchEpoch === switchEpoch) {
                    currentModel = targetModel;
                  }
                },
                () => {}
              );
              return;
            }
            currentModel = targetModel;
          }
          if (pc.isCancelled(seq)) return;
          buildStarted = label === 'A' ? true : buildStarted;
          ran.push(label);
        })
        .finally(() => pc.settle(seq));
    };

    enqueueWithSwitch('model-b', wedgedSwitch, 'A');
    await tick(); // link A is parked on the wedged setModel round-trip
    assert.equal(pc.cancelPending(), 1, 'the mid-setModel prompt counts as pending');

    // The user's immediate resend (no model change) must run even though the
    // cancelled switch NEVER resolves.
    enqueueWithSwitch('model-a', Promise.resolve(), 'B');
    const outcome = await Promise.race([
      chain.then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(resolve, 2_000, 'timeout')),
    ]);
    assert.equal(outcome, 'done', 'a wedged cancelled setModel must not block the chain');
    assert.equal(buildStarted, false, 'the cancelled prompt never starts its prep');
    assert.deepEqual(ran, ['B'], 'the resend ran; the cancelled prompt did not');

    // If the abandoned switch DOES land later, its bookkeeping is recorded
    // (the CLI really changed models) — the resend above claimed no epoch.
    releaseModelSwitch();
    await tick();
    assert.equal(currentModel, 'model-b', 'a late switch completion records the model');
  }

  // The epoch guard: when a NEWER link claims the model after the cancelled
  // one, the late completion must NOT clobber the newer bookkeeping.
  {
    const pc = createPromptCancellation();
    let chain: Promise<void> = Promise.resolve();
    let currentModel = 'model-a';
    let modelSwitchEpoch = 0;
    let releaseOldSwitch: () => void = () => {};
    const oldSwitch = new Promise<void>((resolve) => {
      releaseOldSwitch = resolve;
    });

    const enqueueWithSwitch = (targetModel: string, switchWork: Promise<void>) => {
      const seq = pc.issueSeq();
      chain = chain
        .then(async () => {
          if (pc.isCancelled(seq)) return;
          if (targetModel !== currentModel) {
            const switchEpoch = ++modelSwitchEpoch;
            const switched = await pc.race(switchWork.then(() => true as const));
            if (switched === null) {
              void switchWork.then(
                () => {
                  if (modelSwitchEpoch === switchEpoch) {
                    currentModel = targetModel;
                  }
                },
                () => {}
              );
              return;
            }
            currentModel = targetModel;
          }
        })
        .finally(() => pc.settle(seq));
    };

    enqueueWithSwitch('model-b', oldSwitch); // stop lands mid round-trip
    await tick();
    pc.cancelPending();
    enqueueWithSwitch('model-c', Promise.resolve()); // resend claims a newer switch
    await tick();
    assert.equal(currentModel, 'model-c', 'the resend recorded its own switch');
    releaseOldSwitch(); // the abandoned switch lands after the newer claim
    await tick();
    assert.equal(currentModel, 'model-c', 'a stale late completion must not clobber it');
  }

  // A cancelled setModel that eventually REJECTS is abandoned work: it must
  // neither surface as a runner error nor crash the process.
  {
    const pc = createPromptCancellation();
    let rejectSwitch: (error: Error) => void = () => {};
    const doomedSwitch = new Promise<void>((_resolve, reject) => {
      rejectSwitch = reject;
    });
    pc.issueSeq();
    const raced = pc.race(doomedSwitch.then(() => true as const));
    pc.cancelPending();
    assert.equal(await raced, null, 'cancellation wins over the wedged switch');
    void doomedSwitch.then(
      () => {},
      () => {}
    );
    rejectSwitch(new Error('control request failed after cancel'));
    await tick();
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
