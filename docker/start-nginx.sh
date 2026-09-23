#!/bin/sh
set -eu

: "${CANOPY_UPSTREAM:=http://canopy-api:8000}"
: "${CANOPY_API_KEY:?CANOPY_API_KEY must be set}"
export CANOPY_UPSTREAM

envsubst '${CANOPY_UPSTREAM} ${CANOPY_API_KEY}' \
  < /app/nginx.conf.template \
  > /tmp/nginx.conf

exec nginx -c /tmp/nginx.conf -g 'daemon off;'
