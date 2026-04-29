FROM node:20-bookworm-slim AS client-build
WORKDIR /app
COPY client/package*.json client/
RUN npm ci --prefix client && ln -s /app/client/node_modules /app/node_modules
COPY client client
COPY shared shared
RUN npm run build --prefix client

FROM node:20-bookworm-slim AS server-build
WORKDIR /app
COPY server/package*.json server/
RUN npm ci --prefix server && ln -s /app/server/node_modules /app/node_modules
COPY server server
COPY shared shared
RUN npm run build --prefix server

FROM node:20-bookworm-slim AS server-runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_PATH=/app/server/dist
COPY server/package*.json server/
RUN npm ci --omit=dev --prefix server && npm cache clean --force
COPY --from=server-build /app/server/dist server/dist
RUN ln -s /app/server/dist/shared/src /app/server/dist/@shared
EXPOSE 3001
CMD ["npm", "--prefix", "server", "run", "start"]

FROM caddy:2-alpine AS web-runtime
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=client-build /app/client/dist /srv
