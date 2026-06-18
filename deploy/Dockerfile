# AetherMux orchestrator — deployment image.
#
# Multi-stage: build the console SPA and the orchestrator, then run on a slim
# runtime that serves BOTH the API/WebSocket and the console at the same origin
# (so the browser needs only one port and a token — no ?api=, no CORS).
# Build context is the repo root.

# --- console build -----------------------------------------------------------
FROM node:20-slim AS console
WORKDIR /app
COPY console/package.json console/package-lock.json ./console/
RUN cd console && npm ci
COPY console ./console
COPY src ./src
RUN cd console && npm run build

# --- orchestrator build ------------------------------------------------------
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
COPY --from=console /app/console/dist ./public
# Serve the bundled console SPA at / (same origin as the API).
ENV AETHERMUX_CONSOLE_DIR=/app/public

# HTTP API port (override with the PORT env var).
EXPOSE 8080

# The orchestrator main loop: connect store → recover → serve API + console.
CMD ["node", "dist/main.js"]
