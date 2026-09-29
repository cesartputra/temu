#!/bin/sh
set -eu
: "${TEMU_SERVER_TOKEN:?Isi TEMU_SERVER_TOKEN di Variables Helipod}"
: "${TEMU_ALLOWED_HOSTS:?Isi TEMU_ALLOWED_HOSTS dengan hostname HTTPS publik}"
export TEMU_PRIVATE_MEDIA_DIR=/data/private-media
exec python3 server/server.py --host 0.0.0.0 --port "${PORT:-8080}" --data-dir /data --backup-dir /data/backups
