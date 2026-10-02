/** Bound keeper reads. Receipt/nonce checks precede queued discovery reads. */
export class AutomaticReadLimit {
  private active = 0;
  private waiting: { priority: number; start: () => void }[] = [];
  constructor(readonly limit = 4) {
    if (limit < 1) throw new Error("invalid_read_limit");
  }
  async run<T>(work: () => Promise<T>, priority = 1): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => {
        this.active++;
        resolve();
      };
      if (this.active < this.limit) start();
      else {
        this.waiting.push({ priority, start });
        this.waiting.sort((a, b) => a.priority - b.priority);
      }
    });
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.start();
    }
  }
}
export function claimPollDelay(
  pending: number | null,
  busy: boolean | null,
  failed: boolean,
  idleMs: number,
): number {
  if (pending === null || busy === null || failed || pending > 0 || busy)
    return 2000;
  return idleMs;
}
