#!/usr/bin/env bash
# =============================================================================
#  Prepara a BD da PLATAFORMA em produção (Neon): utilizadores de privilégios
#  mínimos, migrações e permissões. Idempotente — pode correr-se a cada versão
#  nova (aplica as migrações em falta).
#
#  1. Crie o projeto no Neon (região Frankfurt, perto do Render) e uma BD,
#     ex.: eduflow_platform.
#  2. Guarde o URL do DONO (neondb_owner) num ficheiro — nunca na linha de comandos:
#        secrets-prod/neon-owner.url
#  3. bash scripts/prod/bootstrap-db.sh
#
#  Saída: secrets-prod/render-env.txt — os URLs de cada serviço, para colar no
#  Render (Environment). Nada de segredos é mostrado no terminal.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 22.15.0 >/dev/null 2>&1 || true
OUT=${SECRETS_DIR:-secrets-prod}
IMG=postgres:18-alpine
[ -s "$OUT/neon-owner.url" ] || { echo "✗ falta $OUT/neon-owner.url (URL do dono da BD no Neon)"; exit 1; }
chmod 600 "$OUT/neon-owner.url"

if [ ! -f "$OUT/db-passwords.env" ]; then
  umask 077
  cat > "$OUT/db-passwords.env" <<EOF
MIGRATOR_PW=$(openssl rand -hex 24)
PLATFORM_APP_PW=$(openssl rand -hex 24)
PROVISIONER_PW=$(openssl rand -hex 24)
DIRECTORY_PW=$(openssl rand -hex 24)
EOF
  echo "✓ senhas dos utilizadores da BD geradas ($OUT/db-passwords.env)"
fi
source "$OUT/db-passwords.env"
export MIGRATOR_PW PLATFORM_APP_PW PROVISIONER_PW DIRECTORY_PW

# URLs derivados do do dono (endpoint DIRETO — o pooler do Neon não serve para migrações)
eval "$(OWNER="$(cat "$OUT/neon-owner.url")" node -e '
  const u = new URL(process.env.OWNER.trim());
  u.hostname = u.hostname.replace(/-pooler(?=\.)/, "");
  const db = u.pathname.slice(1);
  const ssl = "?sslmode=" + (process.env.DB_SSLMODE || "require");
  const as = (user, pw) => { const x = new URL(u); x.username = user; x.password = pw; x.search = ssl; return x.toString(); };
  const q = (s) => "\x27" + s.replace(/\x27/g, "") + "\x27";
  const owner = new URL(u); owner.search = ssl;
  console.log("DB_NAME=" + q(db));
  console.log("OWNER_URL=" + q(owner.toString()));
  console.log("MIGRATOR_URL=" + q(as("eduflow_migrator", process.env.MIGRATOR_PW)));
  console.log("PLATFORM_URL=" + q(as("eduflow_platform_app", process.env.PLATFORM_APP_PW)));
  console.log("PROVISIONER_URL=" + q(as("eduflow_provisioner", process.env.PROVISIONER_PW)));
  console.log("DIRECTORY_URL=" + q(as("eduflow_school_directory", process.env.DIRECTORY_PW)));
')"

psql_as() { # url ficheiro.sql [-v …]
  local url=$1 file=$2; shift 2
  docker run --rm -i --network host -e DB_URL="$url" "$IMG" sh -c 'psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@" -f -' -- "$@" < "$file"
}

echo "• utilizadores de privilégios mínimos…"
psql_as "$OWNER_URL" infra/db/roles-prod.sql \
  -v dbname="$DB_NAME" -v migrator_pw="$MIGRATOR_PW" -v platform_pw="$PLATFORM_APP_PW" \
  -v provisioner_pw="$PROVISIONER_PW" -v directory_pw="$DIRECTORY_PW"
echo "✓ utilizadores"

echo "• migrações (como eduflow_migrator)…"
# O endereço do Neon tem IPv4 e IPv6; em redes sem IPv6 (ex.: WSL) o motor do Prisma às vezes
# tenta primeiro um IPv6 e falha (P1001). Repetir é seguro: o deploy só aplica o que falta,
# cada migração na sua transação.
migrated=0
for attempt in 1 2 3 4 5; do
  if out=$(PLATFORM_MIGRATOR_URL="${MIGRATOR_URL}&connect_timeout=30" TENANT_DATABASE_URL="postgresql://unused@localhost/unused" \
      pnpm exec prisma migrate deploy --schema prisma/platform/schema.prisma 2>&1); then
    echo "$out" | grep -E "applied|No pending|Applying" || true
    migrated=1
    break
  fi
  if echo "$out" | grep -q "P1001"; then
    echo "  ligação falhou (tentativa $attempt/5) — a repetir…"
    sleep 3
  else
    echo "$out" | sed -E 's#://[^@]+@#://***@#g' | tail -15
    break
  fi
done
[ "$migrated" = 1 ] || { echo "✗ as migrações não foram aplicadas — nada mais foi feito"; exit 1; }
echo "✓ migrações"

psql_as "$MIGRATOR_URL" infra/db/grants.sql
echo "✓ permissões por tabela"

umask 077
cat > "$OUT/render-env.txt" <<EOF
# Colar no Render → cada serviço → Environment (são segredos: não partilhar)

[eduflow-platform-api]
PLATFORM_DATABASE_URL=$PLATFORM_URL

[eduflow-school-api]
DIRECTORY_DATABASE_URL=$DIRECTORY_URL

[eduflow-provisioner]  (quando for ativado)
PROVISIONER_DATABASE_URL=$PROVISIONER_URL
EOF
echo "✓ URLs de cada serviço em $OUT/render-env.txt"
