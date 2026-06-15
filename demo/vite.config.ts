import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The lab imports the real SDK from ../src and the harness from ../test/harness,
// both of which live outside this package's root, so the dev server must be
// allowed to read the repository root. Vite/esbuild resolve the SDK's `.js`
// relative imports to their `.ts` sources automatically.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [".."] },
  },
});
