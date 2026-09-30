FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# The SQLite database lives on a mounted volume so it survives redeploys.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV DB_PATH=/data/pharmacy.db \
    PORT=3000 \
    COOKIE_SECURE=1

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
