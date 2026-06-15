/**
 * examples/devnet-demo.ts — a live, end-to-end run of solana-resilience-kit on
 * Solana devnet. It exercises the whole pipeline against the real network:
 *
 *   1. Build a ResilientRpcPool over two devnet RPC endpoints (failover + health).
 *   2. Probe provider health via Diagnostics.probeEndpoints.
 *   3. Load a persisted devnet keypair (or generate + save one), and fund it.
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
 * Devnet only. On first run it generates a keypair, saves it to the gitignored
 * `.devnet-keypair.json`, and tries the public faucet. That faucet is aggressively
 * rate-limited (often 1 airdrop per IP per day), so if it fails the script prints
 * the address and exits — fund that address by any means, then re-run and it
 * reuses the saved keypair and lands the transaction. You can also point it at a
 * specific key with SOLANA_SECRET_KEY (a JSON array of the 64 secret-key bytes),
 * or set DEVNET_RPC_2 to a second provider's URL to see cross-provider failover.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  airdropFactory,
  appendTransactionMessageInstruction,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
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
const KEYPAIR_FILE = ".devnet-keypair.json";

/** JSON.stringify replacer that renders bigints (slots, block heights) as strings. */
const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/**
 * Generate a fresh Ed25519 keypair as the 64-byte Solana secret key (32-byte
 * seed || 32-byte public key) — the same layout `solana-keygen` writes and that
 * `createKeyPairSignerFromBytes` expects. WebCrypto keys from kit are
 * non-extractable, so we mint one via Node crypto to get persistable bytes.
 */
function freshSecretKeyBytes(): Uint8Array {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const seed = pkcs8.subarray(pkcs8.length - 32); // Ed25519 PKCS8: seed is the last 32 bytes
  const pub = spki.subarray(spki.length - 32); // SPKI: raw public key is the last 32 bytes
  return Uint8Array.from([...seed, ...pub]);
}

/** env SOLANA_SECRET_KEY > persisted .devnet-keypair.json > freshly generated + saved. */
async function loadOrCreateSigner(): Promise<KeyPairSigner> {
  const fromEnv = process.env.SOLANA_SECRET_KEY;
  if (fromEnv) {
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fromEnv) as number[]));
    console.log("using SOLANA_SECRET_KEY signer:", signer.address);
    return signer;
  }
  if (existsSync(KEYPAIR_FILE)) {
    const bytes = Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_FILE, "utf8")) as number[]);
    const signer = await createKeyPairSignerFromBytes(bytes);
    console.log("loaded persisted signer:", signer.address);
    return signer;
  }
  const bytes = freshSecretKeyBytes();
  const signer = await createKeyPairSignerFromBytes(bytes);
  writeFileSync(KEYPAIR_FILE, JSON.stringify(Array.from(bytes)));
  console.log("generated + saved signer:", signer.address, `(→ ${KEYPAIR_FILE})`);
  return signer;
}

/**
 * Ensure the fee payer holds lamports. Tries the public faucet when empty; if
 * that fails (commonly rate-limited), prints the address to fund manually and
 * returns false so the caller can exit gracefully. Returns true once funded.
 */
async function ensureFunded(rpc: Rpc<SolanaRpcApi>, signer: KeyPairSigner): Promise<boolean> {
  const { value: balance } = await rpc.getBalance(signer.address).send();
  if (balance > 0n) {
    console.log(`balance: ${Number(balance) / 1e9} SOL — funded`);
    return true;
  }
  console.log("balance: 0 — requesting devnet airdrop…");
  try {
    const airdrop = airdropFactory({
      rpc: createSolanaRpc(devnet(DEVNET_HTTP)),
      rpcSubscriptions: createSolanaRpcSubscriptions(devnet(DEVNET_WS)),
    });
    await airdrop({
      recipientAddress: signer.address,
      lamports: lamports(1_000_000_000n), // 1 SOL
      commitment: "confirmed",
    });
    return true;
  } catch (err) {
    console.warn("airdrop failed (the public faucet is often rate-limited):", String((err as Error)?.message ?? err));
    console.warn(`→ fund ${signer.address} on devnet by any means, then re-run this script.`);
    return false;
  }
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

  // 3. Wallet — load/persist a keypair and make sure it is funded.
  const signer = await loadOrCreateSigner();
  if (!(await ensureFunded(rpc, signer))) return;

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
