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
# tsc only compiles .ts/.json — copy the admin dashboard SPA into the
# compiled tree so the runtime image can serve it without bringing
# the whole src/. Server tsconfig has rootDir=".." so the source
# `server/src/admin/routes.ts` lands at
# `dist/server/src/admin/routes.js`; place dashboard.html alongside.
RUN cp /app/server/src/admin/dashboard.html /app/server/dist/server/src/admin/dashboard.html

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
