# Multi-stage image for the API server and dashboard.
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN apk add --no-cache libstdc++ \
  && apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps
COPY tsconfig*.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace=packages/shared

FROM base AS server
COPY packages/server packages/server
RUN npm run build --workspace=packages/server
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
USER node
ENV AGENT_PROXY_HOST=0.0.0.0
EXPOSE 8300
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8300/health || exit 1
CMD ["node", "packages/server/dist/index.js"]

FROM base AS dashboard-build
COPY packages/dashboard packages/dashboard
RUN npm run build --workspace=packages/dashboard

FROM nginx:alpine AS dashboard
COPY --from=dashboard-build /app/packages/dashboard/dist /usr/share/nginx/html
COPY <<'CONF' /etc/nginx/templates/default.conf.template
server {
    listen 80;
    location /admin { proxy_pass ${AGENT_PROXY_UPSTREAM}; proxy_set_header Host $host; proxy_read_timeout 300s; proxy_send_timeout 300s; }
    location /v1 { proxy_pass ${AGENT_PROXY_UPSTREAM}; proxy_set_header Host $host; proxy_buffering off; proxy_read_timeout 300s; proxy_send_timeout 300s; }
    location /health { proxy_pass ${AGENT_PROXY_UPSTREAM}; }
    location / { root /usr/share/nginx/html; try_files $uri /index.html; }
}
CONF
ENV AGENT_PROXY_UPSTREAM=http://127.0.0.1:8300
ENV NGINX_ENVSUBST_FILTER=AGENT_PROXY_UPSTREAM
EXPOSE 80

FROM server
