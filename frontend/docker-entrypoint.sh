#!/bin/sh
set -eu

# Keep workers bounded on small Railway containers; "auto" can over-spawn.
sed -i 's/worker_processes\s\+auto;/worker_processes 1;/' /etc/nginx/nginx.conf

# Runtime config allows Railway service variables to control backend origin
# without requiring Docker build args.
envsubst '${VITE_BACKEND_URL}' \
  < /usr/share/nginx/html/config.template.js \
  > /usr/share/nginx/html/config.js

exec nginx -g 'daemon off;'
