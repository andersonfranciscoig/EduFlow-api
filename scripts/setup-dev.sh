#!/usr/bin/env bash
# =============================================================================
#  Ambiente de desenvolvimento seguro do EduFlow-api.
#   - gera chaves (tokens ES256 + RSA para credenciais dos colégios)
#   - gera senhas e um .env POR SERVIÇO (cada um só com o que precisa)
#   - cria os utilizadores PostgreSQL de privilégios mínimos
#   - aplica migrações e permissões
#  Uso: bash scripts/setup-dev.sh [--force]   (--force regenera chaves e senhas)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
FORCE="${1:-}"
DB_HOST=localhost
DB_PORT=5435

mkdir -p secrets && chmod 700 secrets

# ---------------------------------------------------------------- chaves
gen_ec() { # par ES256
  [ -f "secrets/$1.key" ] && [ "$FORCE" != "--force" ] && return
  openssl ecparam -name prime256v1 -genkey -noout -out "secrets/$1.key" 2>/dev/null
  openssl ec -in "secrets/$1.key" -pubout -out "secrets/$1.pub" 2>/dev/null
  echo "✓ chave $1 (ES256)"
}
gen_ec staff-jwt       # tokens da equipa EduFlow       → só platform-api
gen_ec customer-jwt    # tokens dos responsáveis        → só platform-api
if [ ! -f secrets/tenant-credentials.key ] || [ "$FORCE" = "--force" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out secrets/tenant-credentials.key 2>/dev/null
  openssl pkey -in secrets/tenant-credentials.key -pubout -out secrets/tenant-credentials.pub
  echo "✓ chave tenant-credentials (RSA 3072) — privada só no school-api"
fi
if [ ! -f secrets/mfa.key ] || [ "$FORCE" = "--force" ]; then
  openssl rand -base64 32 > secrets/mfa.key
  echo "✓ chave mfa (AES-256) — cifra os segredos da 2FA; só platform-api"
fi
chmod 600 secrets/*.key

# ---------------------------------------------------------------- senhas
if [ ! -f secrets/db-passwords.env ] || [ "$FORCE" = "--force" ]; then
  cat > secrets/db-passwords.env <<EOF
MIGRATOR_PW=$(openssl rand -hex 24)
PLATFORM_APP_PW=$(openssl rand -hex 24)
PROVISIONER_PW=$(openssl rand -hex 24)
DIRECTORY_PW=$(openssl rand -hex 24)
EOF
  chmod 600 secrets/db-passwords.env
  echo "✓ senhas da base de dados geradas"
fi
source secrets/db-passwords.env
url() { echo "postgresql://$1:$2@$DB_HOST:$DB_PORT/eduflow_platform?schema=public"; }

# ---------------------------------------------------------------- .env por serviço
cat > .env <<EOF
# Só para o CLI do Prisma (migrações). As apps NÃO usam este ficheiro.
PLATFORM_MIGRATOR_URL="$(url eduflow_migrator "$MIGRATOR_PW")"
TENANT_DATABASE_URL="postgresql://unused@localhost:5435/unused"
EOF

cat > apps/platform-api/.env <<EOF
NODE_ENV=development
PORT=4000
FRONTEND_URL="http://localhost:3001"
PLATFORM_DATABASE_URL="$(url eduflow_platform_app "$PLATFORM_APP_PW")"
STAFF_JWT_PRIVATE_KEY_FILE=secrets/staff-jwt.key
STAFF_JWT_PUBLIC_KEY_FILE=secrets/staff-jwt.pub
CUSTOMER_JWT_PRIVATE_KEY_FILE=secrets/customer-jwt.key
CUSTOMER_JWT_PUBLIC_KEY_FILE=secrets/customer-jwt.pub
MFA_ENCRYPTION_KEY_FILE=secrets/mfa.key
JWT_EXPIRES_IN_SECONDS=28800
DEFAULT_PHONE_COUNTRY_CODE="244"
STORAGE_DIR=./storage/platform
EOF

cat > apps/school-api/.env <<EOF
NODE_ENV=development
PORT=4001
DIRECTORY_DATABASE_URL="$(url eduflow_school_directory "$DIRECTORY_PW")"
TENANT_CREDENTIALS_PRIVATE_KEY_FILE=secrets/tenant-credentials.key
EOF

cat > apps/provisioner/.env <<EOF
NODE_ENV=development
PROVISIONER_DATABASE_URL="$(url eduflow_provisioner "$PROVISIONER_PW")"
TENANT_DB_HOST=$DB_HOST
TENANT_DB_PORT=$DB_PORT
TENANT_CREDENTIALS_PUBLIC_KEY_FILE=secrets/tenant-credentials.pub
POLL_INTERVAL_MS=3000
EOF
chmod 600 .env apps/*/.env
echo "✓ .env de cada serviço escritos"

# ---------------------------------------------------------------- base de dados
docker compose up -d >/dev/null
for i in $(seq 1 30); do docker exec eduflow-platform-db pg_isready -U eduflow -d eduflow_platform >/dev/null 2>&1 && break; sleep 1; done

docker exec -i eduflow-platform-db psql -v ON_ERROR_STOP=1 -q -U eduflow -d eduflow_platform \
  -v migrator_pw="$MIGRATOR_PW" -v platform_pw="$PLATFORM_APP_PW" \
  -v provisioner_pw="$PROVISIONER_PW" -v directory_pw="$DIRECTORY_PW" \
  -f - < infra/db/roles.sql
echo "✓ utilizadores PostgreSQL de privilégios mínimos"

pnpm exec prisma migrate deploy --schema prisma/platform/schema.prisma | grep -E "applied|No pending|Applying" || true
bash scripts/db-grants.sh
pnpm exec prisma generate --schema prisma/platform/schema.prisma >/dev/null
pnpm exec prisma generate --schema prisma/tenant/schema.prisma >/dev/null
echo "✓ clientes Prisma gerados"
echo
echo "Pronto. Arranque tudo com: pnpm dev"
