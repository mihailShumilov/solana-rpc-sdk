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

// The cookbook examples import the published package names —
// `solana-resilience-kit` and `solana-resilience-kit/testing` — so the displayed
// code is exactly what a consumer writes. There is no published copy on disk
// here, so we alias those specifiers to the in-repo TypeScript sources (`../src`
// and `../test/harness`). Vite resolves their `.js` ESM imports to the `.ts`
// sources, just like the Lab does.
const repoFile = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  // @solana/web3.js v1 and the wallet-adapter reference `global`; map it to globalThis.
  define: { global: "globalThis" },
  resolve: {
    // Array form so the `/testing` subpath is matched before the bare package
    // (first match wins). Order matters.
    alias: [
      { find: /^solana-resilience-kit\/testing$/, replacement: repoFile("test/harness/index.ts") },
      { find: /^solana-resilience-kit$/, replacement: repoFile("src/index.ts") },
      { find: "@solana/kit", replacement: demoModule("@solana/kit") },
      { find: "@opentelemetry/api", replacement: demoModule("@opentelemetry/api") },
    ],
  },
  server: {
    fs: { allow: [".."] },
  },
});
