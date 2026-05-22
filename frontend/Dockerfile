# syntax=docker/dockerfile:1
# Build SPA with Vite, serve with nginx (tiny runtime, gzip, security headers).

FROM node:20-alpine AS builder

WORKDIR /src

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Drop default config so our server block is authoritative.
RUN rm -f /etc/nginx/conf.d/default.conf
RUN apk add --no-cache gettext

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /src/dist /usr/share/nginx/html
COPY config.template.js /usr/share/nginx/html/config.template.js
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# nginx master runs as root; workers drop privileges — standard pattern for this image.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
