import "./polyfills";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter } from "@solana/wallet-adapter-base";
import { App } from "./App";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

// Standard Solana wallet-adapter setup. An empty `wallets` array relies on the
// Wallet Standard, so Phantom (and any other standard wallet) auto-registers and
// appears in the WalletMultiButton's selection modal.
function Root() {
  const wallets = useMemo<Adapter[]>(() => [], []);
  return (
    <ConnectionProvider endpoint={DEVNET_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

// No StrictMode: the Lab holds an imperative SDK/harness instance, and we want a
// single, stable instantiation rather than dev-mode double-mounting.
createRoot(document.getElementById("root")!).render(<Root />);
