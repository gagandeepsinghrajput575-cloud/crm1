# syntax=docker/dockerfile:1
#
# Build context is the REPOSITORY ROOT, not server/ — the API also ships the
# static UI (index.html + js/), which lives above server/.
#   docker build -f server/Dockerfile .

# ---------------------------------------------------------------- deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency changes.
COPY server/package.json server/package-lock.json ./
RUN npm ci --include=dev && npm prune --omit=dev

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app
COPY server/prisma ./prisma
COPY server/prisma.config.ts server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/public

# tini reaps zombies and forwards SIGTERM, so container shutdown reaches Node
# and the graceful drain in src/index.ts actually runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY server/package.json server/prisma.config.ts ./
COPY server/prisma ./prisma

# The UI, served from the same origin as the API so there is no CORS and no
# API-discovery step for the browser to get wrong.
COPY index.html ./public/index.html
COPY js ./public/js

USER node
EXPOSE 4000

# Readiness, not liveness: an orchestrator should only route traffic to a
# container that can actually reach its database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
