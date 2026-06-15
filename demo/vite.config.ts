import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The lab imports the real SDK from ../src and the harness from ../test/harness,
// both of which live outside this package's root, so the dev server must be
// allowed to read the repository root. Vite/esbuild resolve the SDK's `.js`
// relative imports to their `.ts` sources automatically.
//
// The SDK source imports `@solana/kit` and `@opentelemetry/api` as bare
// specifiers. Node resolves those from the *importer* (../src), i.e. the repo
// root's node_modules — which means a deploy that only installs this package
// (Cloudflare with root directory = demo) wouldn't find them. We declare them as
// this package's own dependencies and alias the bare specifiers to this
// package's node_modules so the demo is fully self-contained. The alias targets
// the package *directory* (not a file) so Vite still applies the `browser`
// export condition (@solana/kit ships a dedicated browser build).
const demoModule = (name: string) =>
  fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // @solana/web3.js v1 and the wallet-adapter reference `global`; map it to globalThis.
  define: { global: "globalThis" },
  resolve: {
    alias: {
      "@solana/kit": demoModule("@solana/kit"),
      "@opentelemetry/api": demoModule("@opentelemetry/api"),
    },
  },
  server: {
    fs: { allow: [".."] },
  },
});
