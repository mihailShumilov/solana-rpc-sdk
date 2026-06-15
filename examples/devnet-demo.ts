/**
 * examples/devnet-demo.ts — a live, end-to-end run of solana-resilience-kit on
 * Solana devnet. It exercises the whole pipeline against the real network:
 *
 *   1. Build a ResilientRpcPool over two devnet RPC endpoints (failover + health).
 *   2. Probe provider health via Diagnostics.probeEndpoints.
 *   3. Get (or generate + airdrop) a devnet keypair.
 *   4. Build and sign a 0.001 SOL self-transfer with @solana/kit.
 *   5. Size the priority fee / CU via FeeEstimator (simulate + percentile oracle).
 *   6. Land it through TransactionSender (maxRetries:0, bounded rebroadcast,
 *      never re-signs — so it can never double-charge).
 *   7. Explain the final outcome via Diagnostics.explainTransaction.
 *
 * Run from the repo root (tsx + @solana-program/system are already devDeps):
 *   npm install
 *   npx tsx examples/devnet-demo.ts
 *
 * Devnet only. By default it generates a throwaway keypair and funds it from the
 * public faucet — but that faucet is aggressively rate-limited (often 1 airdrop
 * per IP per day), so for a reliable run export SOLANA_SECRET_KEY as a JSON array
 * of the 64 secret-key bytes of a pre-funded devnet keypair:
 *   SOLANA_SECRET_KEY='[12,34,...]' npx tsx examples/devnet-demo.ts
 * Set DEVNET_RPC_2 to a second provider's URL to see real cross-provider
 * failover / freshness routing.
 */
import {
  airdropFactory,
  appendTransactionMessageInstruction,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

import {
  Diagnostics,
  FeeEstimator,
  NativeFeeOracle,
  ResilientRpcPool,
  TransactionSender,
} from "../src/index.js";

const DEVNET_HTTP = "https://api.devnet.solana.com";
const DEVNET_WS = "wss://api.devnet.solana.com";
const DEVNET_HTTP_2 = process.env.DEVNET_RPC_2 ?? DEVNET_HTTP;

/** JSON.stringify replacer that renders bigints (slots, block heights) as strings. */
const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function loadOrCreateSigner(): Promise<KeyPairSigner> {
  const fromEnv = process.env.SOLANA_SECRET_KEY;
  if (fromEnv) {
    const bytes = Uint8Array.from(JSON.parse(fromEnv) as number[]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    console.log("using SOLANA_SECRET_KEY signer:", signer.address);
    return signer;
  }

  const signer = await generateKeyPairSigner();
  console.log("generated throwaway signer:", signer.address, "— requesting devnet airdrop…");
  const airdrop = airdropFactory({
    rpc: createSolanaRpc(devnet(DEVNET_HTTP)),
    rpcSubscriptions: createSolanaRpcSubscriptions(devnet(DEVNET_WS)),
  });
  await airdrop({
    recipientAddress: signer.address,
    lamports: lamports(1_000_000_000n), // 1 SOL
    commitment: "confirmed",
  });
  return signer;
}

async function main(): Promise<void> {
  // 1. Resilient pool over two endpoints (same URL unless DEVNET_RPC_2 is set).
  const pool = new ResilientRpcPool({
    endpoints: [
      { name: "devnet-a", transport: createDefaultRpcTransport({ url: DEVNET_HTTP }) },
      { name: "devnet-b", transport: createDefaultRpcTransport({ url: DEVNET_HTTP_2 }) },
    ],
  });
  const rpc = pool.rpc(); // a normal @solana/kit RPC, failover + freshness underneath

  // 2. Probe provider health.
  const diag = new Diagnostics();
  const probe = await diag.probeEndpoints([
    { name: "devnet-a", rpc: createSolanaRpc(devnet(DEVNET_HTTP)) },
    { name: "devnet-b", rpc: createSolanaRpc(devnet(DEVNET_HTTP_2)) },
  ]);
  console.log("health probe:", JSON.stringify(probe, bigintReplacer, 2));

  // 3. Wallet.
  const signer = await loadOrCreateSigner();

  // 4. Build + sign a 0.001 SOL self-transfer.
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: signer,
          destination: signer.address,
          amount: lamports(1_000_000n), // 0.001 SOL, back to self
        }),
        m,
      ),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  const wireTransaction = getBase64EncodedWireTransaction(signed);

  // 5. Size the priority fee / CU (illustrative — in production you'd add the
  //    setComputeUnitLimit/Price instructions before signing).
  const fee = new FeeEstimator(rpc, new NativeFeeOracle(rpc));
  const budget = await fee.estimate({ wireTransaction, writableAccounts: [signer.address] });
  console.log("compute budget:", budget);

  // 6. Land it through the resilient sender.
  console.log("sending", signature, "…");
  const txSender = new TransactionSender(rpc);
  const result = await txSender.sendAndConfirm({
    wireTransaction,
    signature,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  console.log("send result:", JSON.stringify(result, bigintReplacer, 2));

  // 7. Explain the outcome.
  const explanation = await diag.explainTransaction(rpc, {
    signature,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  console.log("diagnosis:", explanation);

  console.log(
    result.outcome === "confirmed"
      ? `✅ landed: https://explorer.solana.com/tx/${signature}?cluster=devnet`
      : `⚠️ outcome=${result.outcome} — see diagnosis above`,
  );
}

main().catch((err) => {
  console.error("devnet demo failed:", err);
  process.exitCode = 1;
});

main().catch((err) => {
  console.error("devnet demo failed:", err);
  process.exitCode = 1;
});
