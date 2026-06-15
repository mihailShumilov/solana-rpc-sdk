/**
 * SPEC (red until implemented): the wallet adapter must sign with the wallet
 * then push the signed tx through the resilient sender — adding resilience that
 * @solana/wallet-adapter does not provide.
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport } from "@solana/kit";
import { ResilientWalletAdapter, type WalletSigner } from "../../src/wallet/adapter.js";
import { TransactionSender } from "../../src/tx/sender.js";
import { MockCluster, MockEndpoint } from "../harness/index.js";

describe("ResilientWalletAdapter", () => {
  it("signs with the wallet, then sends through the resilient sender", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    const sleep = async () => {
      cluster.advanceSlots(1);
    };
    const sender = new TransactionSender(rpc, { sleep });

    const signer: WalletSigner = {
      address: "Wa11et1111111111111111111111111111111111111",
      // signing "returns" a short string the mock treats as the raw signature
      signTransaction: vi.fn(async () => "SigWallet1"),
    };

    const adapter = new ResilientWalletAdapter({ signer, sender });
    const res = await adapter.signAndSend("unsignedWire", 400n);

    expect(signer.signTransaction).toHaveBeenCalledOnce();
    expect(res.outcome).toBe("confirmed");
  });
});
