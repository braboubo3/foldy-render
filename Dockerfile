# Base image with Chromium & all Playwright deps preinstalled
# IMPORTANT: keep this version in sync with package.json "playwright"
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Install production deps (use lockfile if present)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --fund=false; \
    else \
      npm install --omit=dev --no-audit --fund=false; \
    fi

# Copy source
COPY . .

# (Optional but recommended) run as the non-root user that exists in this base image
# and ensure we own /app so Playwright caches can be written if needed.
RUN chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Default entrypoint = API. The worker service will override this in Render
# with: Docker Command → `node worker.js`
CMD ["node","index.js"]
