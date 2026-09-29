# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Only the manifests, so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
# Dev dependencies are needed at build time (typescript, prisma) but not at
# runtime, so they are pruned out in the same layer.
RUN npm ci --include=dev && npm prune --omit=dev

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

# tini reaps zombies and forwards SIGTERM, so container shutdown reaches Node
# and the graceful drain in src/index.ts actually runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY package.json prisma.config.ts ./
COPY prisma ./prisma

# Run unprivileged. The `node` user ships with the base image.
USER node

EXPOSE 4000

# Readiness (not liveness) so an orchestrator only routes traffic to a
# container that can actually reach its database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
