# Playwright image version MUST match the "playwright" version in package-lock.json (1.65.0).
# Multi-arch image: works on x86 (Render, most VPS) and arm64 servers.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app

# Defaults are tuned for Render Free (512 MB RAM, 0.1 CPU):
#  - one clone at a time, everyone else waits in a live queue
#  - small Chromium + Node heaps so the container never runs out of memory
# Bigger servers override these in docker-compose.yml / the host's env settings.
ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1 \
    NODE_OPTIONS=--max-old-space-size=256 \
    MAX_CONCURRENT_JOBS=1 \
    MAX_JOBS_PER_IP=2 \
    MAX_QUEUE_LENGTH=15 \
    MAX_PAGES=100 \
    CRAWL_BUDGET_MAX_MIN=25 \
    CHROMIUM_HEAP_MB=192 \
    CHROMIUM_RENDERER_LIMIT=2 \
    RETENTION_HOURS=24 \
    ASSET_FETCH_CONCURRENCY=4 \
    MAX_ASSET_MB=40 \
    INBROWSER_MAX_ASSET_MB=3

COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install chromium

COPY . .

RUN mkdir -p storage/sites storage/zips

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
