#!/bin/sh
set -eu

# Railway injects PORT at runtime. Keep local default for docker run/dev.
PORT="${PORT:-80}"

# Render nginx server listen port from runtime env.
# sed is used instead of envsubst to avoid silent failures when PORT is not
# exported into the envsubst environment on some sh implementations.
sed -i "s/\${PORT}/${PORT}/g" /etc/nginx/conf.d/default.conf

# Runtime config allows Railway service variables to control backend origin
# without requiring Docker build args.
envsubst '${VITE_BACKEND_URL}' \
  < /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec nginx -g 'daemon off;'
