#!/usr/bin/env bash
# =============================================================================
#  Corre o PROVISIONER de produção a partir deste computador (enquanto não há
#  worker pago no Render). Só faz ligações de SAÍDA: à BD da plataforma (Neon)
#  e aos servidores de BD registados no painel.
#
#  Cria as BDs dos colégios ativados, testa servidores e faz cópias.
#  Ctrl+C para parar — pode correr só quando for preciso.
#
#  Uso: bash scripts/prod/provisioner-local.sh
#  Precisa de: secrets-prod/render-env.txt (bootstrap-db.sh) e secrets-prod/provisioner/ (gen-secrets.sh).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use 22.15.0 >/dev/null 2>&1 || true
S=secrets-prod

# Produção corre SÓ o código do main: as migrações das BDs dos colégios são lidas
# da pasta prisma/tenant/migrations deste checkout. Noutro ramo, faltariam (ou
# sobrariam) migrações em relação à API que está no Render.
BRANCH=$(git branch --show-current)
[ "$BRANCH" = main ] || { echo "✗ está no ramo '$BRANCH'. Corra no main:  git checkout main && git pull"; exit 1; }
[ -z "$(git status --porcelain -- apps libs prisma)" ] || { echo "✗ há alterações por guardar em apps/, libs/ ou prisma/ — produção só corre código do main tal como está no GitHub"; exit 1; }
if git fetch -q origin main 2>/dev/null; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "✗ o main local não é igual ao do GitHub. Atualize:  git pull --ff-only"; exit 1; }
else
  echo "! sem ligação ao GitHub — a usar o main local ($(git log --oneline -1))"
fi
echo "• código: main $(git log --oneline -1) · migrações dos colégios: $(ls prisma/tenant/migrations | tr '\n' ' ')"

PROV_URL=$(sed -n 's/^PROVISIONER_DATABASE_URL=//p' "$S/render-env.txt")
[ -n "$PROV_URL" ] || { echo "✗ falta PROVISIONER_DATABASE_URL em $S/render-env.txt (corra scripts/prod/bootstrap-db.sh)"; exit 1; }
for f in tenant-credentials.pub server-credentials.key backup.key; do
  [ -s "$S/provisioner/$f" ] || { echo "✗ falta $S/provisioner/$f (corra scripts/prod/gen-secrets.sh)"; exit 1; }
done

# compila se não houver build ou se o código for mais recente do que a versão compilada
MAIN=dist/apps/provisioner/src/main.js
if [ ! -f "$MAIN" ] || [ -n "$(find apps/provisioner/src libs/kernel/src prisma -newer "$MAIN" -type f -print -quit)" ]; then
  echo "• a compilar a versão atual…"
  pnpm run build >/dev/null
fi

export NODE_ENV=production
export PROVISIONER_DATABASE_URL="$PROV_URL"
export TENANT_CREDENTIALS_PUBLIC_KEY_FILE="$S/provisioner/tenant-credentials.pub"
export SERVER_CREDENTIALS_PRIVATE_KEY_FILE="$S/provisioner/server-credentials.key"
export BACKUP_KEY_FILE="$S/provisioner/backup.key"
# cópias numa pasta local (o UploadThing com ficheiros privados exige plano pago)
export BACKUP_STORAGE=local
export BACKUP_LOCAL_DIR="$S/backups"
export LOCAL_FALLBACK_SERVER=false
# pg_dump 18 (o Neon usa PG 18)
export PG_DUMP_DOCKER_IMAGE=postgres:18-alpine

echo "• provisioner de PRODUÇÃO a correr localmente (Ctrl+C para parar)"
exec node --enable-source-maps dist/apps/provisioner/src/main.js
