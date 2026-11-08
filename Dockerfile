FROM node:22-alpine

LABEL org.opencontainers.image.title="Arr411 Web" \
      org.opencontainers.image.description="qBittorrent, Radarr, Sonarr et Lidarr dans le navigateur, avec connexion par utilisateur."

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# The code stays read-only for the unprivileged user; only the data volume is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/index.js"]
