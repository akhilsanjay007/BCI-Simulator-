# syntax=docker/dockerfile:1
# Build SPA with Vite, serve with nginx (tiny runtime, gzip, security headers).

FROM node:20-alpine AS builder

WORKDIR /src

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Backend origin is baked in at build time (Vite); Railway sets this for the frontend service.
ARG VITE_BACKEND_URL=http://localhost:8000
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}

RUN npm run build

# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Drop default config so our server block is authoritative.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /src/dist /usr/share/nginx/html

# nginx master runs as root; workers drop privileges — standard pattern for this image.
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
