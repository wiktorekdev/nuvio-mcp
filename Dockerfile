# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The unprivileged user must own the data volume for session/snapshots/audit.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NUVIO_TRANSPORT=http \
    NUVIO_HTTP_HOST=0.0.0.0 \
    NUVIO_HTTP_PORT=3333 \
    NUVIO_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3333/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
