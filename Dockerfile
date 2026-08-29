# --- Base -------------------------------------------------------------
FROM node:18-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- Dependencies -------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime -------------------------------------------------------------
FROM base AS runner

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN rm -f .env .env.* && rm -rf .git

USER nodejs

EXPOSE 4000
ENV PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]