# Reproducible build/test environment for solana-resilience-kit.
# Debian-slim (not alpine) to avoid native/wasm build surprises with @solana/kit.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV CI=true \
    NODE_ENV=development

# --- deps layer: cached unless lockfile changes ---------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- dev/test image: code + deps -----------------------------------------
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Default action: typecheck then run the full suite.
# (Module specs are RED until implemented — that is the expected TDD signal.)
CMD ["sh", "-c", "npm run typecheck && npm test"]
