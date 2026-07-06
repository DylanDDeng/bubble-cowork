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

  // ── Model-switch state machine (mirrors runner.ts) ─────────────────────────
  // The CLI's model is not a settled scalar once switches can be abandoned:
  // bookkeeping is tri-state — 'confirmed' (scalar matches the CLI, equal
  // models may skip), 'pending' (a switch is in flight, possibly abandoned;
  // links must issue their own switch), 'unknown' (the newest switch
  // rejected; an explicit switch is required). Only the outcome of the most
  // recently issued switch may transition the state.
  type ModelState = 'confirmed' | 'pending' | 'unknown';
  const makeModelHarness = (pc: ReturnType<typeof createPromptCancellation>) => {
    let chain: Promise<void> = Promise.resolve();
    const harness = {
      currentModel: 'model-a' as string | undefined,
      modelState: 'confirmed' as ModelState,
      switchesIssued: [] as string[],
      ran: [] as string[],
      switchSeq: 0,
      issueSwitch(target: string | undefined, work: Promise<void>): Promise<void> {
        const mySeq = ++harness.switchSeq;
        harness.modelState = 'pending';
        harness.switchesIssued.push(target ?? '(default)');
        work.then(
          () => {
            if (mySeq === harness.switchSeq) {
              harness.currentModel = target;
              harness.modelState = 'confirmed';
            }
          },
          () => {
            if (mySeq === harness.switchSeq) {
              harness.modelState = 'unknown';
            }
          }
        );
        return work;
      },
      enqueue(target: string, work: Promise<void>, label: string) {
        const seq = pc.issueSeq();
        chain = chain
          .then(async () => {
            if (pc.isCancelled(seq)) return;
            if (target !== harness.currentModel || harness.modelState !== 'confirmed') {
              const modelSwitch = harness.issueSwitch(target, work);
              const switched = await pc.race(modelSwitch.then(() => true as const));
              if (switched === null) return;
            }
            if (pc.isCancelled(seq)) return;
            harness.ran.push(label);
          })
          .catch(() => {
            // a live link's switch rejection surfaces here (runner: onError)
          })
          .finally(() => pc.settle(seq));
      },
      settled(): Promise<string> {
        return Promise.race([
          chain.then(() => 'done'),
          new Promise<string>((resolve) => setTimeout(resolve, 2_000, 'timeout')),
        ]);
      },
    };
    return harness;
  };

  // Wedged cancelled switch: the chain must release even if the control
  // request NEVER resolves (after a zero-turn stop nothing else would
  // reclaim it), and — P1 regression — a follow-up requesting the SAME
  // display model must NOT trust the stale scalar: it issues its own switch,
  // whose outcome (last issued wins on the serial stream) is the CLI's
  // final state; the abandoned switch's late success is then ignored.
  {
    const pc = createPromptCancellation();
    const h = makeModelHarness(pc);
    let releaseOldSwitch: () => void = () => {};
    const wedgedSwitch = new Promise<void>((resolve) => {
      releaseOldSwitch = resolve;
    });

    h.enqueue('model-b', wedgedSwitch, 'B-prompt'); // A→B switch, then stop
    await tick();
    assert.equal(pc.cancelPending(), 1, 'the mid-setModel prompt counts as pending');

    h.enqueue('model-a', Promise.resolve(), 'A-resend'); // same display model!
    assert.equal(await h.settled(), 'done', 'a wedged cancelled switch must not block the chain');
    assert.deepEqual(h.ran, ['A-resend'], 'the resend ran; the cancelled prompt did not');
    assert.deepEqual(
      h.switchesIssued,
      ['model-b', 'model-a'],
      'the same-model resend must issue its own switch — the pending A→B switch means the scalar lies'
    );
    assert.equal(h.currentModel, 'model-a', 'the resend confirmed its own model');
    assert.equal(h.modelState, 'confirmed');

    releaseOldSwitch(); // the abandoned A→B switch lands after the newer one
    await tick();
    assert.equal(h.currentModel, 'model-a', 'a superseded late success must not clobber the state');
  }

  // Cancelled switch with NO follow-up: the late completion still records
  // the model — the CLI really changed, and the next send must compare
  // against reality.
  {
    const pc = createPromptCancellation();
    const h = makeModelHarness(pc);
    let releaseSwitch: () => void = () => {};
    const slowSwitch = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    h.enqueue('model-b', slowSwitch, 'B-prompt');
    await tick();
    pc.cancelPending();
    assert.equal(await h.settled(), 'done');
    assert.equal(h.modelState, 'pending', 'the abandoned switch is still unsettled');
    releaseSwitch();
    await tick();
    assert.equal(h.currentModel, 'model-b', 'the newest switch, however late, confirms the model');
    assert.equal(h.modelState, 'confirmed');
  }

  // P2 regression: a NEWER switch that REJECTS must not hide the older
  // cancelled switch's completion behind stale bookkeeping. The rejection
  // moves the state to 'unknown', the old success is superseded (ignored),
  // and the next prompt — even for the ORIGINAL model — must issue an
  // explicit switch instead of trusting the scalar.
  {
    const pc = createPromptCancellation();
    const h = makeModelHarness(pc);
    let releaseOldSwitch: () => void = () => {};
    const oldSwitch = new Promise<void>((resolve) => {
      releaseOldSwitch = resolve;
    });
    let rejectNewSwitch: (error: Error) => void = () => {};
    const doomedSwitch = new Promise<void>((_resolve, reject) => {
      rejectNewSwitch = reject;
    });

    h.enqueue('model-b', oldSwitch, 'B-prompt'); // A→B, stopped mid round-trip
    await tick();
    pc.cancelPending();
    h.enqueue('model-c', doomedSwitch, 'C-prompt'); // live follow-up, will fail
    await tick();
    rejectNewSwitch(new Error('setModel failed'));
    assert.equal(await h.settled(), 'done');
    assert.equal(h.modelState, 'unknown', 'the newest switch rejected — the CLI model is uncertain');

    releaseOldSwitch(); // the old A→B switch lands late
    await tick();
    assert.equal(h.modelState, 'unknown', 'a superseded success must not fake a confirmation');

    h.enqueue('model-a', Promise.resolve(), 'A-prompt'); // original model!
    assert.equal(await h.settled(), 'done');
    assert.deepEqual(
      h.switchesIssued,
      ['model-b', 'model-c', 'model-a'],
      'with the model unknown, even the original-model prompt must switch explicitly'
    );
    assert.equal(h.currentModel, 'model-a');
    assert.equal(h.modelState, 'confirmed');
    assert.deepEqual(h.ran, ['A-prompt'], 'only the healthy prompt ran');
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
