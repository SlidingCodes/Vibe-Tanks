FROM node:20-alpine AS build

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci

COPY server/ ./
COPY shared/ /app/shared/

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app/server
ENV NODE_ENV=production

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/server/dist ./dist

EXPOSE 3001

CMD ["node", "dist/server/src/index.js"]
