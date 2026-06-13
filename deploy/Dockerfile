# AetherMux orchestrator — deployment image (Phase 1 skeleton).
#
# Multi-stage: build TypeScript in a full image, then run on a slim runtime.
# This is a skeleton; runtime entrypoint and service wiring land with the
# orchestrator implementation in later child issues.

# --- build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Placeholder entrypoint — replaced when the orchestrator process exists.
CMD ["node", "dist/index.js"]
