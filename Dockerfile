# Playwright image with all system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium

COPY . .
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node","index.js"]
