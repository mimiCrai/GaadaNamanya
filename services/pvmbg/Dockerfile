FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/src/db ./src/db

ENV NODE_ENV=production
ENV PORT=8082
USER node

EXPOSE 8082

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "./dist/src/healthcheck.js"]

CMD ["sh", "-c", "npm run db:migrate && exec node ./dist/src/server.js"]
