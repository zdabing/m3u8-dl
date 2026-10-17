FROM node:24-alpine AS builder
WORKDIR /app
ARG USE_PREBUILT=false
COPY . .
RUN if [ "$USE_PREBUILT" = "true" ] && [ -f client/index.html ] && [ -f cjs/server/index.js ]; then \
      echo "Using prebuilt downloader"; \
    else \
      npm install -g pnpm@10 && pnpm install --no-frozen-lockfile && pnpm build; \
    fi

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DS_PORT=6600 DS_SAVE_DIR=/app/downloads DS_CACHE_DIR=/app/cache
COPY --from=builder /app/package.json ./
RUN npm install --omit=dev --ignore-scripts && apk add --no-cache ffmpeg
COPY --from=builder /app/cjs ./cjs
COPY --from=builder /app/client/index.html ./client/index.html
COPY --from=builder /app/client/assets ./client/assets
COPY --from=builder /app/bin ./bin
VOLUME ["/app/downloads", "/app/cache"]
EXPOSE 6600
CMD ["node", "cjs/server/index.js"]
