#!/bin/sh
set -eu
: "${TEMU_SERVER_TOKEN:?Isi TEMU_SERVER_TOKEN di Variables Helipod}"
if [ "${TEMU_SERVICE_ROLE:-guestbook}" = "album" ]; then
  : "${TEMU_ALBUM_PROXY_KEY:?Isi kunci internal album}"
  : "${TEMU_GUESTBOOK_URL:?Isi hostname internal buku tamu}"
  exec python3 server/album_server.py --host 0.0.0.0 --port "${PORT:-8080}" --data-dir /data --backup-dir /data/backups
fi
: "${TEMU_ALLOWED_HOSTS:?Isi TEMU_ALLOWED_HOSTS dengan hostname HTTPS publik}"
export TEMU_PRIVATE_MEDIA_DIR=/data/private-media
exec python3 server/server.py --host 0.0.0.0 --port "${PORT:-8080}" --data-dir /data --backup-dir /data/backups
