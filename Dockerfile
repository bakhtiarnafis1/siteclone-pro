# Official Microsoft Playwright image with Chromium and all Linux dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Copy package files and install dependencies (skip browser download as image already includes it)
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

# Copy application code
COPY server.js cloner.js ./
COPY public ./public

# Create storage directories
RUN mkdir -p storage/sites storage/zips

# Render assigns dynamic PORT via env var (default 3000)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
