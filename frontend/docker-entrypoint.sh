#!/bin/sh
set -eu

# Runtime config allows Railway service variables to control backend origin
# without requiring Docker build args.
envsubst '${VITE_BACKEND_URL}' \
  < /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec nginx -g 'daemon off;'
