FROM node:22-alpine
WORKDIR /app
# zip für die Browser Erweiterung; python3, make und g++ für better-sqlite3
RUN apk add --no-cache python3 make g++ zip
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY web ./web
COPY extension ./extension
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /app/server
EXPOSE 80
ENV PORT=80 NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:80/api/health > /dev/null || exit 1
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "server/index.mjs"]
