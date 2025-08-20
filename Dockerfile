# Playwright image with all system deps preinstalled
FROM mcr.microsoft.com/playwright:v1.45.0-jammy
WORKDIR /app

# copy manifests first for layer caching
COPY package*.json ./

# Use npm install (generates lockfile inside the image). Postinstall will run:
#   npx playwright install chromium
RUN npm install --omit=dev

# now copy the app code
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node","index.js"]
