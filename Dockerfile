# syntax=docker/dockerfile:1
# One image for both services; docker-compose.yml picks the command.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/mcp-search/package.json apps/mcp-search/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY apps ./apps
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/mcp-search/package.json apps/mcp-search/
COPY apps/web/package.json apps/web/
# Production dependencies of the two Node services only (the web app ships as static files).
RUN npm ci --omit=dev --workspace=@docqa/server --workspace=@docqa/mcp-search && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/mcp-search/dist apps/mcp-search/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY data/samples data/samples
COPY data/eval data/eval
RUN mkdir -p data/index && chown -R node:node data
USER node
EXPOSE 3000 8787
CMD ["node", "apps/server/dist/index.js"]
