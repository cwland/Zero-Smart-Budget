# Production image: the built web app and the API in one container, on port 4000.
# Built on GitHub for every push to main (.github/workflows/docker.yml) as
# ghcr.io/cwland/zero-smart-budget:latest. For development, docker-compose.yml still uses
# backend/Dockerfile and frontend/Dockerfile.

# 1. The web pages
FROM node:22-alpine AS web
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2. The server, compiled to plain JavaScript
FROM node:22-alpine AS api
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# 3. What runs: production packages only
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 WEB_DIR=/app/web BACKUP_DIR=/app/backups
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=api /src/backend/dist ./dist
COPY backend/drizzle ./drizzle
COPY backend/assets ./assets
COPY --from=web /src/frontend/dist /app/web
RUN mkdir -p /app/backups && chown node:node /app/backups
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
# Database migrations run automatically when the server starts
CMD ["node", "dist/index.js"]
