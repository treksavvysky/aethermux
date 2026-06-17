# AetherMux Phase 2 console — multi-stage build of the static SPA, served by nginx.
#
# Build context is the repo ROOT (not console/) because the console imports the
# orchestrator's shared wire types from ../../src/server. Build with:
#   docker build -f console/Dockerfile -t aethermux-console .

# --- build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Install console deps first (cached unless the lockfile changes).
COPY console/package.json console/package-lock.json ./console/
RUN cd console && npm ci

# Console sources + the orchestrator's shared types it imports (../../src/server).
COPY console ./console
COPY src ./src
RUN cd console && npm run build

# --- runtime stage: static SPA via nginx ------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/console/dist /usr/share/nginx/html
EXPOSE 80
# Default nginx config serves /usr/share/nginx/html — fine for a single-page app.
