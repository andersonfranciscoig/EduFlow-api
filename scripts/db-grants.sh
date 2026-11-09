#!/usr/bin/env bash
# Aplica infra/db/grants.sql como eduflow_migrator (dono das tabelas).
set -euo pipefail
cd "$(dirname "$0")/.."
source secrets/db-passwords.env
docker exec -i -e PGPASSWORD="$MIGRATOR_PW" eduflow-platform-db \
  psql -v ON_ERROR_STOP=1 -q -h localhost -U eduflow_migrator -d eduflow_platform -f - < infra/db/grants.sql
echo "✓ permissões por tabela aplicadas"
