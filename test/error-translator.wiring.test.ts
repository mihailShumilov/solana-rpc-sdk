/**
 * SPEC: TransactionSender, ResilientWalletAdapter, and the diagnostics CLI all
 * surface ErrorTranslator output at their boundaries (issue #2 wiring).
 */
import { describe, it, expect, vi } from "vitest";
import { createSolanaRpcFromTransport, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { TransactionSender } from "../src/tx/sender.js";
import { ResilientWalletAdapter, type WalletSigner } from "../src/wallet/adapter.js";
import { TranslatedError } from "../src/error-translator.js";
import { run } from "../src/cli/index.js";
import { MockCluster, MockEndpoint } from "./harness/index.js";

describe("error translation at boundaries", () => {
  it("TransactionSender translates an initial-broadcast failure", async () => {
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          throw new Error("Attempt to debit an account but found no record of a prior credit. (0x1)");
        },
      }),
    } as unknown as Rpc<SolanaRpcApi>;
    const sender = new TransactionSender(rpc, { sleep: async () => {} });

    await expect(
      sender.sendAndConfirm({ wireTransaction: "W", signature: "S", lastValidBlockHeight: 800n }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
  });

  it("ResilientWalletAdapter surfaces a wallet rejection as USER_REJECTED", async () => {
    const cluster = new MockCluster({ initialBlockHeight: 300n });
    const rpc = createSolanaRpcFromTransport(new MockEndpoint(cluster).transport);
    const sender = new TransactionSender(rpc, { sleep: async () => cluster.advanceSlots(1) });
    const signer: WalletSigner = {
      address: "Wa11et",
      signTransaction: vi.fn(async () => {
        throw new Error("User rejected the request.");
      }),
    };
    const adapter = new ResilientWalletAdapter({ signer, sender });

    const err = await adapter.signAndSend("unsigned", 400n).catch((e) => e);
    expect(err).toBeInstanceOf(TranslatedError);
    expect(err.code).toBe("USER_REJECTED");
  });

  it("CLI explain prints a translated message and exits 1 on RPC failure", async () => {
    const cluster = new MockCluster();
    const offline = new MockEndpoint(cluster, { name: "down", faults: { offline: true } });
    const out: string[] = [];

    const code = await run(["explain", "--rpc", "https://x", "--sig", "Sig", "--lvbh", "100"], {
      createRpc: () => createSolanaRpcFromTransport(offline.transport),
      log: (l) => out.push(l),
    });

    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("Error:");
    expect(text).toContain("Suggestion:");
  });
});
