import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      // src/index.ts is a re-export barrel. src/react is the optional React
      // subpath (peer-dep `react`, no test runtime configured); its only logic
      // is a thin wrapper over the fully-tested WalletAdapterBridge and it is
      // typechecked separately via `npm run typecheck:react`.
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/react/**"],
      // Bounty target: 90%+ coverage. Enforced once implementation lands.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
