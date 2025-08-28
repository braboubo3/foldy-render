## Base image with browsers & system deps preinstalled
## IMPORTANT: keep this version in sync with package.json "playwright"
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Install production deps using lockfile (faster & reproducible)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start the service
CMD ["node","index.js"]
