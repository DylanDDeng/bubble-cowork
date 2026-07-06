/**
 * Cancellation bookkeeping for the Claude runner's serial prompt-enqueue
 * chain (see runner.ts).
 *
 * Preparing a prompt is async — attachments are read from disk, and a model
 * switch does a control-request round-trip — so a stop can land while a
 * send() is still ahead of the input queue. Two things must then hold:
 *
 * 1. The cancelled prompt never reaches the queue: every enqueue link
 *    re-checks `isCancelled` after each await.
 * 2. The chain settles promptly: the enqueue chain is strictly serial, so a
 *    link parked on a multi-second attachment read would otherwise make the
 *    user's follow-up send wait on the very work they stopped. `race()` lets
 *    a link race its long prepare step against cancellation and bail within
 *    a microtask of `cancelPending()`. The abandoned work keeps running in
 *    the background but its outcome is discarded (and its eventual rejection
 *    swallowed); nothing shared is mutated after the bail-out checks.
 *
 * `cancelPending()` returns how many issued-but-unsettled prompts were
 * cancelled so the caller can drop them from its turn accounting — a
 * cancelled prompt never starts a turn and never produces a result.
 *
 * Pure host-side state (no Electron, no SDK) so the mechanics are
 * unit-testable in isolation.
 */

export interface PromptCancellation {
  /** Number a new enqueue. Call once per send, before the chain link runs. */
  issueSeq(): number;
  /** True when the numbered enqueue was cancelled by a stop. */
  isCancelled(seq: number): boolean;
  /** Mark the numbered enqueue settled (pushed, cancelled, or failed). */
  settle(seq: number): void;
  /**
   * Race a long prepare step against cancellation; resolves `null` the
   * moment `cancelPending()` fires. `work` must never resolve to null
   * itself. If cancellation wins, `work`'s eventual rejection (if any) is
   * swallowed so an abandoned prepare cannot surface as an unhandled
   * rejection.
   */
  race<T>(work: Promise<T>): Promise<T | null>;
  /** Cancel every issued-but-unsettled enqueue; returns how many. */
  cancelPending(): number;
}

export function createPromptCancellation(): PromptCancellation {
  let issuedSeq = 0;
  let settledSeq = 0;
  let cancelledSeq = 0;
  let releaseCancelled: () => void = () => {};
  let cancelSignal = new Promise<void>((resolve) => {
    releaseCancelled = resolve;
  });

  return {
    issueSeq: () => ++issuedSeq,
    isCancelled: (seq: number) => seq <= cancelledSeq,
    settle: (seq: number) => {
      // Monotonic: an abandoned link settling late must never roll the
      // watermark back and inflate a later cancelPending() count.
      settledSeq = Math.max(settledSeq, seq);
    },
    race: <T>(work: Promise<T>): Promise<T | null> => {
      const winner = Promise.race([work, cancelSignal.then(() => null)]);
      void winner.then(
        (value) => {
          if (value === null) {
            // Cancellation won; the abandoned work settles later and must
            // not surface as an unhandled rejection.
            work.catch(() => {});
          }
        },
        () => {}
      );
      return winner;
    },
    cancelPending: () => {
      const pending = issuedSeq - Math.max(settledSeq, cancelledSeq);
      cancelledSeq = issuedSeq;
      // Release every in-flight race, then mint a fresh signal for enqueues
      // issued after this cancellation.
      releaseCancelled();
      cancelSignal = new Promise<void>((resolve) => {
        releaseCancelled = resolve;
      });
      return Math.max(0, pending);
    },
  };
}
