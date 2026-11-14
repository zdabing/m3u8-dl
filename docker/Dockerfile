FROM node:24-alpine AS builder
WORKDIR /app
ARG USE_PREBUILT=false
COPY . .
RUN if [ "$USE_PREBUILT" = "true" ] && [ -f client/index.html ] && [ -f cjs/server/index.js ]; then \
      echo "Using prebuilt downloader"; \
    else \
      npm install -g pnpm@10 && pnpm install --no-frozen-lockfile && pnpm build; \
    fi

FROM node:24-trixie-slim
WORKDIR /app
ENV NODE_ENV=production DS_PORT=6600 DS_SAVE_DIR=/app/downloads DS_CACHE_DIR=/app/cache
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fluxbox fonts-noto-cjk gosu novnc tini websockify x11vnc xauth xvfb \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY --from=builder /app/cjs ./cjs
COPY --from=builder /app/client/index.html ./client/index.html
COPY --from=builder /app/client/assets ./client/assets
COPY --from=builder /app/bin ./bin
COPY docker/start.sh ./start.sh
COPY docker/browser ./browser
VOLUME ["/app/downloads", "/app/cache"]
EXPOSE 6600 6080
ENTRYPOINT ["tini", "-g", "--", "bash", "/app/start.sh"]
CMD ["node", "cjs/server/index.js"]
