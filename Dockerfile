# Official Microsoft Playwright image with Chromium and all Linux dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev

COPY . .

RUN mkdir -p storage/sites storage/zips

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
