#!/bin/sh
# Aplica migraciones pendientes (con el rol dueño de las tablas) y luego arranca el proceso.
# RUN_MIGRATIONS=false lo desactiva (p. ej. en el contenedor `worker`, para no migrar dos veces).
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  ./node_modules/.bin/prisma migrate deploy --config ./db/prisma.config.ts
fi

exec "$@"
