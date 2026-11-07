# Official Microsoft Playwright image with Chromium and all Linux dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npx playwright install chromium

COPY . .

RUN mkdir -p storage/sites storage/zips

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
