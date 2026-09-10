# hpath-server image.
#
# HPath drives a single headless Chromium. We deliberately avoid the official
# mcr.microsoft.com/playwright image because it bakes in Chromium + Firefox +
# WebKit + ffmpeg (~2.3GB) — Firefox/WebKit are never used here. Instead a slim
# Node base installs only the Chromium headless shell and its system libs at
# build time (`--only-shell --with-deps`), which keeps the image far smaller
# while still guaranteeing the browser can launch (asserted below).
#
# The Playwright package version is pinned in packages/server/package.json; the
# browser build must match it or the package cannot locate the executable.
#
# Build context is the repository root: only the workspace manifests,
# proto/, packages/contract and packages/server are needed (see .dockerignore).
FROM node:22-bookworm-slim

# Match the pnpm major that generated pnpm-lock.yaml on the host.
RUN npm install --global pnpm@10.21.0 \
  && npm cache clean --force

WORKDIR /app

# Install from manifests first so source edits reuse the dependency layer.
# --ignore-scripts: the browser is installed explicitly below, so the root
# postinstall (playwright install) must not run a second time here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @hpath/server...

# Only the Chromium headless shell (plus its ffmpeg and required system libs)
# — the full Chrome for Testing build and Firefox/WebKit are never used by the
# headless execute-agent and would add ~640MB. Cached as its own layer: source
# edits do not re-download the browser.
RUN pnpm --filter @hpath/server exec playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

# Hard gate: fail the build if Playwright cannot actually launch chromium.
RUN pnpm --filter @hpath/server exec node -e "const {chromium}=require('playwright');chromium.launch({headless:true}).then(b=>b.close()).then(()=>console.log('chromium headless launch OK')).catch(e=>{console.error('chromium launch failed:',e.message);process.exit(1)})"

COPY tsconfig.base.json ./
COPY proto ./proto
COPY packages/contract ./packages/contract
COPY packages/server ./packages/server
# Bundled PRD fixtures seed the real-mode database (seed.ts walks up to
# <root>/fixtures/prds); the .dockerignore negation keeps them in context.
COPY fixtures/prds ./fixtures/prds
RUN pnpm --filter @hpath/contract --filter @hpath/server build

# Real mode: SQLite + settings live under /data (mounted by compose), and the
# artifact store defaults to the local backend.
ENV HPATH_ARTIFACT_STORE=local \
    HPATH_ARTIFACT_DIR=/data/artifacts
EXPOSE 50051
CMD ["node", "packages/server/dist/index.js", "--real", "--port", "50051"]
