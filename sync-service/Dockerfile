# Stage 1 — compile TypeScript
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

# Stage 2 — runtime (no dev dependencies, no source files)
FROM node:20-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
USER app
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', function(r){ process.exit(r.statusCode === 200 ? 0 : 1) })"
CMD ["node", "dist/index.js"]
