# Rider Requests — single container, no npm dependencies.
FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data BACKUP_DIR=/backups
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY dist ./dist
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.mjs"]
