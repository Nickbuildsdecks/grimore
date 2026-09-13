/**
 * Per-socket token bucket. `rate` tokens are refilled per second up to
 * `burst`; each event consumes one token. Purely in-memory: a socket lives on
 * exactly one node, so no cross-node state is needed.
 */
export interface RateLimitOptions {
  /** Sustained events per second. */
  rate: number;
  /** Maximum tokens held (initial allowance). */
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { rate: 20, burst: 40 };

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(opts: RateLimitOptions = DEFAULT_RATE_LIMIT, now = Date.now()) {
    if (opts.rate <= 0 || opts.burst <= 0) throw new Error('rate and burst must be positive');
    this.rate = opts.rate;
    this.burst = opts.burst;
    this.tokens = opts.burst;
    this.last = now;
  }

  /** Returns true when the event is allowed, false when the caller should drop it. */
  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Current allowance, rounded down. Useful for tests and diagnostics. */
  get remaining(): number {
    return Math.floor(this.tokens);
  }
}
