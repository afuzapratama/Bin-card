/**
 * Token-bucket rate limiter
 * Per-IP rate limiting with configurable windows
 */

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets: Map<string, RateLimitEntry> = new Map();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly cleanupInterval: number;

  constructor(
    maxTokens: number = 100,
    refillRate: number = 10,
    cleanupIntervalMs: number = 60000
  ) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.cleanupInterval = cleanupIntervalMs;

    // Periodic cleanup of expired entries
    setInterval(() => this.cleanup(), this.cleanupInterval);
  }

  /**
   * Check if request is allowed and consume a token
   * @returns { allowed: boolean, remaining: number, resetMs: number }
   */
  consume(key: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    let entry = this.buckets.get(key);

    if (!entry) {
      entry = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(key, entry);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(this.maxTokens, entry.tokens + elapsed * this.refillRate);
    entry.lastRefill = now;

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(entry.tokens),
        resetMs: Math.ceil(((this.maxTokens - entry.tokens) / this.refillRate) * 1000),
      };
    }

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.ceil(((1 - entry.tokens) / this.refillRate) * 1000),
    };
  }

  private cleanup(): void {
    const now = Date.now();
    const staleThreshold = 300000; // 5 minutes

    for (const [key, entry] of this.buckets) {
      if (now - entry.lastRefill > staleThreshold) {
        this.buckets.delete(key);
      }
    }
  }
}

export const rateLimiter = new RateLimiter(100, 20); // 100 tokens, refill 20/sec
