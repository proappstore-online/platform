# PAS build container (ADR-006, Phase 1).
# Runs ONE app build per invocation: clone → install → vite build → sync to R2.
# Kept minimal: node + pnpm + git + awscli (the R2 S3 client). Untrusted creator
# code runs here, so the orchestrator must run it one-shot with constrained
# network egress (GitHub + the R2 endpoint only) and no persistent state.
FROM node:22-bookworm-slim

# git (clone), awscli (R2 S3 sync), ca-certificates (TLS).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates awscli \
  && rm -rf /var/lib/apt/lists/*

# Pin pnpm via corepack (matches the canonical workflow's pnpm/action-setup).
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app
COPY package.json ./
COPY src ./src

# AWS_DEFAULT_REGION is required by awscli for the R2 S3 endpoint.
ENV AWS_DEFAULT_REGION=auto

# The orchestrator injects BUILD_* + R2 creds per run.
ENTRYPOINT ["node", "src/build.mjs"]
