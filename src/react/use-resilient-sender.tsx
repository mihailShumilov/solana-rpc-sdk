/**
 * useResilientSender — an optional React ergonomic over {@link WalletAdapterBridge}
 * (issue #6). It wires a standard `@solana/wallet-adapter` wallet into the
 * resilient sender (and Jito router) and exposes `signAndSend` plus live status
 * sourced from the typed lifecycle event stream.
 *
 * This module lives behind the `./react` subpath export so the core bundle stays
 * framework-agnostic: `react` and `@solana/wallet-adapter-*` are OPTIONAL peer
 * dependencies, imported only here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WalletAdapterBridge,
  type WalletAdapterSigner,
  type TransactionEncoder,
  type BridgeSendOptions,
} from "../wallet/wallet-adapter-bridge.js";
import type { TransactionSender, SendResult } from "../tx/sender.js";
import type { JitoRouter } from "../jito/router.js";
import { LifecycleEmitter, type LifecycleEventMap } from "../events.js";

/** Coarse, UI-friendly status derived from the lifecycle event stream. */
export type ResilientSendStatus = "idle" | "pending" | "sent" | "confirmed" | "failed" | "expired";

export interface UseResilientSenderArgs<TTransaction = string> {
  wallet: WalletAdapterSigner<TTransaction>;
  sender: TransactionSender;
  jito?: JitoRouter;
  encode?: TransactionEncoder<TTransaction>;
  /** Share an emitter to fan status to other UI; one is created if omitted. */
  events?: LifecycleEmitter;
}

export interface UseResilientSenderResult<TTransaction = string> {
  signAndSend: (transaction: TTransaction, options: BridgeSendOptions) => Promise<SendResult>;
  status: ResilientSendStatus;
  /** The most recent error, if the last send failed. */
  error: unknown;
  /** The connected wallet address, or null. */
  address: string | null;
}

const TRANSACTION_STATUSES = {
  "transaction:pending": "pending",
  "transaction:sent": "sent",
  "transaction:confirmed": "confirmed",
  "transaction:failed": "failed",
  "transaction:expired": "expired",
} as const satisfies Partial<Record<keyof LifecycleEventMap, ResilientSendStatus>>;

export function useResilientSender<TTransaction = string>(
  args: UseResilientSenderArgs<TTransaction>,
): UseResilientSenderResult<TTransaction> {
  const { wallet, sender, jito, encode } = args;
  const events = useMemo(() => args.events ?? new LifecycleEmitter(), [args.events]);
  const bridge = useMemo(
    () => new WalletAdapterBridge<TTransaction>({ wallet, sender, jito, encode }),
    [wallet, sender, jito, encode],
  );

  const [status, setStatus] = useState<ResilientSendStatus>("idle");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const keys = Object.keys(TRANSACTION_STATUSES) as Array<keyof typeof TRANSACTION_STATUSES>;
    const offs = keys.map((event) => events.on(event, () => setStatus(TRANSACTION_STATUSES[event])));
    return () => {
      for (const off of offs) off();
    };
  }, [events]);

  const signAndSend = useCallback(
    async (transaction: TTransaction, options: BridgeSendOptions): Promise<SendResult> => {
      setError(null);
      setStatus("pending");
      try {
        const result = await bridge.signAndSend(transaction, options);
        // Drive terminal status from the result so it is correct even when the
        // passed-in sender does not share this hook's event emitter.
        setStatus(result.outcome);
        return result;
      } catch (err) {
        setError(err);
        setStatus("failed");
        throw err;
      }
    },
    [bridge],
  );

  return { signAndSend, status, error, address: bridge.address };
}
