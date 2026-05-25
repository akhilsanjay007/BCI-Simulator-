#!/bin/sh
set -eu

# Railway injects PORT at runtime. Keep local default for docker run/dev.
: "${PORT:=80}"

# Render nginx server listen port from runtime env.
envsubst '${PORT}' \
  < /etc/nginx/conf.d/default.conf \
  > /etc/nginx/conf.d/default.conf.rendered
mv /etc/nginx/conf.d/default.conf.rendered /etc/nginx/conf.d/default.conf

# Runtime config allows Railway service variables to control backend origin
# without requiring Docker build args.
envsubst '${VITE_BACKEND_URL}' \
  < /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec nginx -g 'daemon off;'
