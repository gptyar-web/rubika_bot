# Official multi-platform node:24-alpine index, resolved from Docker Hub.
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base
ENV NODE_ENV=production
WORKDIR /app
USER node

# Public files only: never copy the repository or private configuration here.
FROM base AS web
COPY --chown=node:node package.json index.html manifest.webmanifest sw.js README.md ./
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node docs/FEATURES.md docs/feature-status.json ./docs/
COPY --chown=node:node scripts/serve.mjs ./scripts/serve.mjs
ENV PORT=4173
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:4173/',{signal:AbortSignal.timeout(4000)});process.exit(r.ok?0:1)"]
CMD ["node", "scripts/serve.mjs"]

# Private poller: no public HTTP listener and no credentials in image layers.
FROM base AS worker
COPY --chown=node:node server/package.json ./server/package.json
COPY --chown=node:node server/runtime/worker.js ./server/runtime/worker.js
COPY --chown=node:node server/supabase/functions/rubika-panel/lib/ ./server/supabase/functions/rubika-panel/lib/
HEALTHCHECK --interval=60s --timeout=30s --start-period=120s --retries=3 \
  CMD ["node", "server/runtime/worker.js", "--healthcheck"]
CMD ["node", "server/runtime/worker.js"]
