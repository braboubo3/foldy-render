## Base image with browsers & system deps preinstalled
## IMPORTANT: keep this version in sync with package.json "playwright"
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Install production deps (use lockfile if present)
# package*.json matches package.json and (optionally) package-lock.json
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi


# Copy source code
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start the service
CMD ["node","index.js"]
