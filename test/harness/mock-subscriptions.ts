/**
 * MockSubscriptions — a deterministic, test-driven stand-in for the kit/v2
 * `RpcSubscriptions` surface that ConfirmationTracker's WebSocket fast-path
 * consumes. It implements exactly the slice the tracker uses:
 *
 *   subscriptions.signatureNotifications(sig, { commitment }).subscribe({ abortSignal })
 *     -> Promise<AsyncIterable<{ context: { slot }, value: { err } }>>
 *
 * Notifications are delivered only when a test calls `notify()`, so WS timing
 * is fully under test control (same philosophy as the manual MockCluster clock).
 * `failSubscription()` models a transport that rejects on subscribe, and
 * `endStream()` models a socket that closes without ever delivering — both must
 * make the tracker fall back to pure polling with no unhandled rejection.
 */
export interface SignatureNotification {
  readonly context: { readonly slot: bigint };
  readonly value: { readonly err: unknown };
}

interface Queued {
  err: unknown;
  slot: bigint;
}

export class MockSubscriptions {
  private readonly queued = new Map<string, Queued[]>();
  private readonly waiters = new Map<string, Array<(n: Queued | null) => void>>();
  private readonly failSigs = new Set<string>();
  private failAll = false;
  /** Counters tests can assert against. */
  readonly stats = { subscribes: 0 };

  /** Deliver (or queue, if not yet subscribed) one signature notification. */
  notify(signature: string, n: { err?: unknown; slot?: bigint } = {}): void {
    const notif: Queued = { err: n.err ?? null, slot: n.slot ?? 0n };
    const waiting = this.waiters.get(signature);
    if (waiting && waiting.length > 0) {
      waiting.shift()!(notif);
      return;
    }
    const q = this.queued.get(signature) ?? [];
    q.push(notif);
    this.queued.set(signature, q);
  }

  /** Make `subscribe()` reject. With no signature, every subscription fails. */
  failSubscription(signature?: string): void {
    if (signature === undefined) this.failAll = true;
    else this.failSigs.add(signature);
  }

  /** Close an open stream without delivering (socket closed). */
  endStream(signature: string): void {
    const waiting = this.waiters.get(signature);
    if (waiting) {
      for (const resolve of waiting.splice(0)) resolve(null);
    }
  }

  signatureNotifications(
    signature: string,
    _config?: { commitment?: "confirmed" | "finalized" },
  ): { subscribe(options: { abortSignal: AbortSignal }): Promise<AsyncIterable<SignatureNotification>> } {
    const self = this;
    return {
      async subscribe({ abortSignal }: { abortSignal: AbortSignal }): Promise<AsyncIterable<SignatureNotification>> {
        self.stats.subscribes += 1;
        if (self.failAll || self.failSigs.has(signature)) {
          throw new Error(`mock subscription rejected for ${signature}`);
        }
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<SignatureNotification> {
            for (;;) {
              if (abortSignal.aborted) return;
              const notif = await self.take(signature, abortSignal);
              if (notif === null) return; // aborted or stream closed
              yield { context: { slot: notif.slot }, value: { err: notif.err } };
            }
          },
        };
      },
    };
  }

  private take(signature: string, signal: AbortSignal): Promise<Queued | null> {
    const q = this.queued.get(signature);
    if (q && q.length > 0) return Promise.resolve(q.shift()!);
    return new Promise<Queued | null>((resolve) => {
      const arr = this.waiters.get(signature) ?? [];
      arr.push(resolve);
      this.waiters.set(signature, arr);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }
}
