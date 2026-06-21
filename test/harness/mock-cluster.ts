/**
 * MockCluster — an in-memory, deterministic model of a Solana cluster's RPC
 * surface, sufficient to exercise the resilience SDK's real behavior offline.
 *
 * Design notes:
 *  - The clock is fully manual: nothing advances unless a test calls
 *    `advanceSlots()`. This makes blockhash-expiry and rebroadcast timing
 *    deterministic instead of wall-clock dependent.
 *  - u64 fields (slot, blockHeight, lastValidBlockHeight, unitsConsumed) are
 *    returned as `bigint`, matching `@solana/kit` response types.
 *  - `sendTransaction` accepts the base64 wire tx and derives the signature the
 *    same way kit does, so a test can sign a real kit transaction and assert.
 *  - Landing semantics model the two terminal failure modes precisely:
 *      * silent drop  -> tx stays pending forever, status is always null
 *      * blockhash expiry -> once blockHeight passes the tx deadline it can
 *        never land (status stays null); the SDK must give up at
 *        lastValidBlockHeight rather than poll forever.
 */
import { base58Encode, firstSignatureFromWireBase64 } from "./base58.js";

const BLOCKHASH_VALIDITY_BLOCKS = 150n;

export type Commitment = "processed" | "confirmed" | "finalized";

export interface MockClusterOptions {
  initialSlot?: bigint;
  initialBlockHeight?: bigint;
  /** Slots between when a tx is accepted and when it lands (default 1). */
  defaultLandingDelaySlots?: number;
  /** Seed used to mint deterministic blockhash strings. */
  blockhashSeed?: number;
  /** Genesis hash this cluster reports (default = mainnet-beta's). */
  genesisHash?: string;
}

interface PendingTx {
  signature: string;
  acceptedAtBlockHeight: bigint;
  deadlineBlockHeight: bigint;
  landAtBlockHeight: bigint; // Infinity-equivalent encoded as -1n when dropped
  dropped: boolean;
  landedSlot: bigint | null;
  status: "pending" | "landed" | "expired";
  err: unknown | null;
}

export interface BlockhashRecord {
  blockhash: string;
  lastValidBlockHeight: bigint;
  issuedAtSlot: bigint;
}

export class MockCluster {
  slot: bigint;
  blockHeight: bigint;
  private readonly defaultLandingDelaySlots: number;
  private blockhashCounter = 0;
  private readonly blockhashSeed: number;
  private latest: BlockhashRecord;
  private readonly txs = new Map<string, PendingTx>();
  /** Per-signature override of landing delay; -1 means "never lands". */
  private readonly landingOverrides = new Map<string, number>();
  /** Per-signature on-chain execution error: the tx LANDS but with `err != null`. */
  private readonly failureOverrides = new Map<string, unknown>();
  private prioritizationFees: bigint[] = [10_000n, 25_000n, 50_000n, 75_000n, 95_000n];
  /** Genesis hash this cluster reports (mainnet-beta's by default). */
  readonly genesisHash: string;

  constructor(opts: MockClusterOptions = {}) {
    this.slot = opts.initialSlot ?? 1000n;
    this.blockHeight = opts.initialBlockHeight ?? 1000n;
    this.defaultLandingDelaySlots = opts.defaultLandingDelaySlots ?? 1;
    this.blockhashSeed = opts.blockhashSeed ?? 1;
    this.genesisHash = opts.genesisHash ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    this.latest = this.mintBlockhash();
  }

  // --- clock control -------------------------------------------------------

  /** Advances the cluster by `n` slots, processing tx landings and expiries. */
  advanceSlots(n: number): void {
    for (let i = 0; i < n; i++) {
      this.slot += 1n;
      this.blockHeight += 1n;
      for (const tx of this.txs.values()) {
        if (tx.status !== "pending") continue;
        if (tx.dropped) continue; // silently dropped: never lands
        if (this.blockHeight > tx.deadlineBlockHeight) {
          tx.status = "expired";
          continue;
        }
        if (tx.landAtBlockHeight >= 0n && this.blockHeight >= tx.landAtBlockHeight) {
          tx.status = "landed";
          tx.landedSlot = this.slot;
        }
      }
    }
  }

  // --- test scripting ------------------------------------------------------

  /** Force the next tx with this signature to land after `slots` (or never if <0). */
  scheduleLanding(signature: string, slots: number): void {
    this.landingOverrides.set(signature, slots);
  }

  /**
   * Force the next tx with this signature to LAND but carry an on-chain
   * execution error (`err != null` in its signature status). Models a tx that
   * was included in a block but reverted — distinct from a silent drop/expiry.
   */
  scheduleFailure(signature: string, err: unknown = { InstructionError: [0, { Custom: 0 }] }): void {
    this.failureOverrides.set(signature, err);
  }

  setPrioritizationFees(fees: bigint[]): void {
    this.prioritizationFees = fees;
  }

  getTx(signature: string): PendingTx | undefined {
    return this.txs.get(signature);
  }

  // --- internal ------------------------------------------------------------

  private mintBlockhash(): BlockhashRecord {
    this.blockhashCounter += 1;
    // Deterministic 32-byte hash -> base58 string.
    const bytes = new Uint8Array(32);
    let x = (this.blockhashSeed + this.blockhashCounter * 2654435761) >>> 0;
    for (let i = 0; i < 32; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      bytes[i] = x & 0xff;
    }
    return {
      blockhash: base58Encode(bytes),
      lastValidBlockHeight: this.blockHeight + BLOCKHASH_VALIDITY_BLOCKS,
      issuedAtSlot: this.slot,
    };
  }

  // --- RPC method implementations (return the JSON-RPC `result` value) ------

  rpcGetSlot(): bigint {
    return this.slot;
  }

  rpcGetBlockHeight(): bigint {
    return this.blockHeight;
  }

  rpcGetGenesisHash(): string {
    return this.genesisHash;
  }

  rpcGetLatestBlockhash(): {
    context: { slot: bigint };
    value: { blockhash: string; lastValidBlockHeight: bigint };
  } {
    this.latest = this.mintBlockhash();
    return {
      context: { slot: this.slot },
      value: {
        blockhash: this.latest.blockhash,
        lastValidBlockHeight: this.latest.lastValidBlockHeight,
      },
    };
  }

  /** Accepts a base64 wire tx (or a raw signature string for low-level tests). */
  rpcSendTransaction(rawTxOrSig: string, opts?: { dropped?: boolean }): string {
    const signature = this.looksLikeBase64WireTx(rawTxOrSig)
      ? firstSignatureFromWireBase64(rawTxOrSig)
      : rawTxOrSig;

    const override = this.landingOverrides.get(signature);
    const delay = override ?? this.defaultLandingDelaySlots;
    const dropped = opts?.dropped === true || override === -1;

    if (!this.txs.has(signature)) {
      this.txs.set(signature, {
        signature,
        acceptedAtBlockHeight: this.blockHeight,
        deadlineBlockHeight: this.latest.lastValidBlockHeight,
        landAtBlockHeight: dropped ? -1n : this.blockHeight + BigInt(Math.max(0, delay)),
        dropped,
        landedSlot: null,
        status: "pending",
        err: this.failureOverrides.get(signature) ?? null,
      });
    }
    return signature;
  }

  rpcGetSignatureStatuses(signatures: string[]): {
    context: { slot: bigint };
    value: Array<null | {
      slot: bigint;
      confirmations: number | null;
      err: unknown | null;
      confirmationStatus: Commitment;
    }>;
  } {
    return {
      context: { slot: this.slot },
      value: signatures.map((sig) => {
        const tx = this.txs.get(sig);
        if (!tx || tx.status !== "landed" || tx.landedSlot === null) return null;
        const age = Number(this.slot - tx.landedSlot);
        return {
          slot: tx.landedSlot,
          confirmations: age >= 32 ? null : age,
          err: tx.err,
          confirmationStatus: age >= 32 ? "finalized" : "confirmed",
        };
      }),
    };
  }

  rpcSimulateTransaction(): {
    context: { slot: bigint };
    value: { err: unknown | null; logs: string[]; unitsConsumed: bigint };
  } {
    return {
      context: { slot: this.slot },
      value: { err: null, logs: [], unitsConsumed: 6000n },
    };
  }

  rpcGetRecentPrioritizationFees(): Array<{ slot: bigint; prioritizationFee: bigint }> {
    return this.prioritizationFees.map((fee, i) => ({
      slot: this.slot - BigInt(this.prioritizationFees.length - i),
      prioritizationFee: fee,
    }));
  }

  private looksLikeBase64WireTx(s: string): boolean {
    // A base58 signature is <=88 chars; a base64 wire transaction is far longer.
    return s.length > 100;
  }
}
