# syntax=docker/dockerfile:1

# ── build ─────────────────────────────────────────────────────────────
# Dev dependencies live only in this stage: vite, tsc and tsx are needed to
# produce web/dist and server/dist and never at runtime.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first, so a dependency install is cached across source edits.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Binaries the default SHELL_ALLOWLIST names. ENABLE_SHELL is false by
# default, but without these the allowlist silently refers to nothing the
# moment anyone turns it on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Only the build output. config.ts resolves the repository root two levels up
# from server/dist, so this layout keeps .env and web/dist where it expects.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# doctor.mjs is worth having in here: a credential that resolves on the host
# may not resolve in the container, and this is where to find out.
COPY scripts ./scripts

# Bind mount points. Both must be writable by uid 1000.
ENV PORT=4300 \
    WORKSPACE_ROOT=/workspace \
    DATA_DIR=/data
RUN mkdir -p /workspace /data && chown -R node:node /workspace /data

USER node
EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
