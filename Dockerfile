FROM node:20-bookworm-slim AS client-build
WORKDIR /app
COPY client/package*.json client/
RUN npm ci --prefix client
COPY client client
COPY shared shared
RUN npm run build --prefix client

FROM node:20-bookworm-slim AS server-build
WORKDIR /app
COPY server/package*.json server/
RUN npm ci --prefix server
COPY server server
COPY shared shared
RUN npm run build --prefix server

FROM node:20-bookworm-slim AS server-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json server/
RUN npm ci --omit=dev --prefix server && npm cache clean --force
COPY --from=server-build /app/server/dist server/dist
EXPOSE 3001
CMD ["npm", "--prefix", "server", "run", "start"]

FROM caddy:2-alpine AS web-runtime
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=client-build /app/client/dist /srv
