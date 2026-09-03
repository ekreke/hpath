# hpath-server image (SPEC T2).
#
# The 1.0 spike runs the mock server: a slim Node base is enough. When the
# execute-agent (T7b) starts driving browsers, switch this base to
# mcr.microsoft.com/playwright:vX.Y.Z-noble (matching the `playwright` npm
# version pinned in packages/server) — `ipc: host` in compose.yaml is already
# set up for it.
#
# Build context is the repository root: only the workspace manifests,
# proto/, packages/contract and packages/server are needed (see .dockerignore).
FROM node:22-bookworm-slim

# Match the pnpm major that generated pnpm-lock.yaml on the host.
RUN npm install --global pnpm@10.21.0 \
  && npm cache clean --force

WORKDIR /app

# Install from manifests first so source edits reuse the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @hpath/server...

COPY tsconfig.base.json ./
COPY proto ./proto
COPY packages/contract ./packages/contract
COPY packages/server ./packages/server
# Bundled PRD fixtures seed the real-mode database (seed.ts walks up to
# <root>/fixtures/prds); the .dockerignore negation keeps them in context.
COPY fixtures/prds ./fixtures/prds
RUN pnpm --filter @hpath/contract --filter @hpath/server build

# 1.0 spike runs mock mode; T5+ swap the internals behind the same contract,
# at which point only this command changes.
ENV HPATH_ARTIFACT_STORE=local \
    HPATH_ARTIFACT_DIR=/data/artifacts
EXPOSE 50051
CMD ["node", "packages/server/dist/index.js", "--mock", "--port", "50051"]
