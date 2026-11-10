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
gen_ec school-jwt      # tokens do portal dos colégios  → só school-api
if [ ! -f secrets/tenant-credentials.key ] || [ "$FORCE" = "--force" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out secrets/tenant-credentials.key 2>/dev/null
  openssl pkey -in secrets/tenant-credentials.key -pubout -out secrets/tenant-credentials.pub
  echo "✓ chave tenant-credentials (RSA 3072) — privada só no school-api"
fi
if [ ! -f secrets/server-credentials.key ] || [ "$FORCE" = "--force" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out secrets/server-credentials.key 2>/dev/null
  openssl pkey -in secrets/server-credentials.key -pubout -out secrets/server-credentials.pub
  echo "✓ chave server-credentials (RSA 3072) — URLs dos servidores de BD; privada só no provisioner"
fi
if [ ! -f secrets/mfa.key ] || [ "$FORCE" = "--force" ]; then
  openssl rand -base64 32 > secrets/mfa.key
  echo "✓ chave mfa (AES-256) — cifra os segredos da 2FA; só platform-api"
fi
if [ ! -f secrets/school-mfa.key ] || [ "$FORCE" = "--force" ]; then
  openssl rand -base64 32 > secrets/school-mfa.key
  echo "✓ chave school-mfa (AES-256) — segredos da 2FA nas BDs dos colégios; só school-api"
fi
chmod 600 secrets/*.key

# ---------------------------------------------------------------- email (Brevo)
# Opcional. Sem secrets/email-api.key os emails aparecem na consola do school-api.
#   secrets/email-api.key → chave da API do Brevo (nunca no git)
#   secrets/email.env     → EMAIL_FROM / EMAIL_REPLY_TO (remetente validado no Brevo)
EMAIL_PROVIDER=console
EMAIL_FROM="noreply@eduflow.ao"
EMAIL_REPLY_TO="noreply@eduflow.ao"
[ -f secrets/email.env ] && source secrets/email.env
if [ -s secrets/email-api.key ]; then
  EMAIL_PROVIDER=brevo
  echo "✓ email via Brevo (remetente $EMAIL_FROM)"
else
  echo "• email na consola (crie secrets/email-api.key para enviar via Brevo)"
fi

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
grep -q '^TENANT_ADMIN_PW=' secrets/db-passwords.env || echo "TENANT_ADMIN_PW=$(openssl rand -hex 24)" >> secrets/db-passwords.env
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
SERVER_CREDENTIALS_PUBLIC_KEY_FILE=secrets/server-credentials.pub
JWT_EXPIRES_IN_SECONDS=28800
DEFAULT_PHONE_COUNTRY_CODE="244"
STORAGE_DIR=./storage/platform
# códigos por email (criar conta, repor senha) e aviso "portal pronto"
PORTAL_URL_TEMPLATE="http://{slug}.localhost:3002"
EMAIL_PROVIDER=$EMAIL_PROVIDER
EMAIL_FROM="$EMAIL_FROM"
EMAIL_FROM_NAME="EduFlow"
EMAIL_REPLY_TO="$EMAIL_REPLY_TO"
EMAIL_API_KEY_FILE=secrets/email-api.key
EOF

cat > apps/school-api/.env <<EOF
NODE_ENV=development
PORT=4001
DIRECTORY_DATABASE_URL="$(url eduflow_school_directory "$DIRECTORY_PW")"
TENANT_CREDENTIALS_PRIVATE_KEY_FILE=secrets/tenant-credentials.key
SCHOOL_JWT_PRIVATE_KEY_FILE=secrets/school-jwt.key
SCHOOL_JWT_PUBLIC_KEY_FILE=secrets/school-jwt.pub
SCHOOL_MFA_KEY_FILE=secrets/school-mfa.key
JWT_EXPIRES_IN_SECONDS=28800
DEFAULT_PHONE_COUNTRY_CODE="244"
# portal (EduFlow-portal): cada colégio no seu subdomínio — em dev, <slug>.localhost:3002
PORTAL_URL_TEMPLATE="http://{slug}.localhost:3002"
EMAIL_PROVIDER=$EMAIL_PROVIDER
EMAIL_FROM="$EMAIL_FROM"
EMAIL_FROM_NAME="EduFlow"
EMAIL_REPLY_TO="$EMAIL_REPLY_TO"
EMAIL_API_KEY_FILE=secrets/email-api.key
EOF

cat > apps/provisioner/.env <<EOF
NODE_ENV=development
PROVISIONER_DATABASE_URL="$(url eduflow_provisioner "$PROVISIONER_PW")"
TENANT_DB_HOST=$DB_HOST
TENANT_DB_PORT=$DB_PORT
TENANT_CREDENTIALS_PUBLIC_KEY_FILE=secrets/tenant-credentials.pub
SERVER_CREDENTIALS_PRIVATE_KEY_FILE=secrets/server-credentials.key
POLL_INTERVAL_MS=3000
HEALTH_CHECK_INTERVAL_MS=300000
# Só desenvolvimento: colégios sem servidor atribuído usam o cluster local
LOCAL_FALLBACK_SERVER=true
EOF
chmod 600 .env apps/*/.env
echo "✓ .env de cada serviço escritos"

# URL de um "servidor partilhado" local para registar no painel (Bases de dados → Adicionar)
echo "postgresql://eduflow_tenant_admin:$TENANT_ADMIN_PW@$DB_HOST:$DB_PORT/postgres" > secrets/dev-tenant-server.url
chmod 600 secrets/dev-tenant-server.url

# ---------------------------------------------------------------- base de dados
docker compose up -d >/dev/null
for i in $(seq 1 30); do docker exec eduflow-platform-db pg_isready -U eduflow -d eduflow_platform >/dev/null 2>&1 && break; sleep 1; done

docker exec -i eduflow-platform-db psql -v ON_ERROR_STOP=1 -q -U eduflow -d eduflow_platform \
  -v migrator_pw="$MIGRATOR_PW" -v platform_pw="$PLATFORM_APP_PW" \
  -v provisioner_pw="$PROVISIONER_PW" -v directory_pw="$DIRECTORY_PW" -v tenant_admin_pw="$TENANT_ADMIN_PW" \
  -f - < infra/db/roles.sql
echo "✓ utilizadores PostgreSQL de privilégios mínimos"

pnpm exec prisma migrate deploy --schema prisma/platform/schema.prisma | grep -E "applied|No pending|Applying" || true
bash scripts/db-grants.sh
pnpm exec prisma generate --schema prisma/platform/schema.prisma >/dev/null
pnpm exec prisma generate --schema prisma/tenant/schema.prisma >/dev/null
echo "✓ clientes Prisma gerados"
echo
echo "Pronto. Arranque tudo com: pnpm dev"
echo "Servidor de BD local para registar no painel: cat secrets/dev-tenant-server.url"
