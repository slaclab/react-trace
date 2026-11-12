#!/bin/sh
set -eu

: "${CANOPY_UPSTREAM:=http://canopy-api:8000}"
: "${CANOPY_API_KEY:?CANOPY_API_KEY must be set}"
# Optional so Trace still starts before the e-log key is provisioned. nginx
# drops an empty header, so e-log calls then fail with Canopy's key error.
: "${CANOPY_ELOG_API_KEY:=}"
if [ -z "$CANOPY_ELOG_API_KEY" ]; then
  echo "start-nginx: CANOPY_ELOG_API_KEY is not set; e-log posting will fail" >&2
fi
export CANOPY_UPSTREAM CANOPY_ELOG_API_KEY

envsubst '${CANOPY_UPSTREAM} ${CANOPY_API_KEY} ${CANOPY_ELOG_API_KEY}' \
  < /app/nginx.conf.template \
  > /tmp/nginx.conf
chmod 0600 /tmp/nginx.conf

exec nginx -c /tmp/nginx.conf -g 'daemon off;'
