#!/usr/bin/env bash
# =============================================================================
#  Chaves de PRODUÇÃO (novas — nunca as de desenvolvimento), já separadas por
#  serviço: cada pasta tem EXATAMENTE os ficheiros a carregar no Render como
#  "Secret Files" desse serviço (ficam em /etc/secrets/<nome>).
#
#  Uso: bash scripts/prod/gen-secrets.sh
#  Saída: secrets-prod/{platform-api,school-api,provisioner}/  (no .gitignore)
#  Nunca regenera o que já existe (perder-se-iam sessões, 2FA e cópias).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=secrets-prod
ALL=$OUT/_all
mkdir -p "$ALL" && chmod 700 "$OUT" "$ALL"

ec() { # par ES256
  [ -f "$ALL/$1.key" ] && return
  openssl ecparam -name prime256v1 -genkey -noout -out "$ALL/$1.key" 2>/dev/null
  openssl ec -in "$ALL/$1.key" -pubout -out "$ALL/$1.pub" 2>/dev/null
  echo "✓ $1 (ES256)"
}
rsa() {
  [ -f "$ALL/$1.key" ] && return
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ALL/$1.key" 2>/dev/null
  openssl pkey -in "$ALL/$1.key" -pubout -out "$ALL/$1.pub"
  echo "✓ $1 (RSA 3072)"
}
aes() {
  [ -f "$ALL/$1.key" ] && return
  openssl rand -base64 32 > "$ALL/$1.key"
  echo "✓ $1 (AES-256)"
}

ec staff-jwt
ec customer-jwt
ec school-jwt
ec support-ticket
rsa tenant-credentials
rsa server-credentials
aes mfa
aes school-mfa
aes backup
aes files

# ---------------------------------------------------------------- por serviço (só o que cada um precisa)
copy() { mkdir -p "$OUT/$1"; for f in "${@:2}"; do cp "$ALL/$f" "$OUT/$1/$f"; done; }
copy platform-api staff-jwt.key staff-jwt.pub customer-jwt.key customer-jwt.pub mfa.key server-credentials.pub support-ticket.key files.key
copy school-api school-jwt.key school-jwt.pub school-mfa.key tenant-credentials.key support-ticket.pub
copy provisioner tenant-credentials.pub server-credentials.key backup.key
chmod -R go-rwx "$OUT"

cat <<'EOF'

Pronto. Falta juntar à mão (não são gerados aqui):
  secrets-prod/platform-api/email-api.key            chave da API do Brevo
  secrets-prod/school-api/email-api.key              (a mesma)
  secrets-prod/platform-api/uploadthing-public.token token do UploadThing (logótipos)
  secrets-prod/provisioner/uploadthing.token         token do UploadThing (cópias — plano pago, ficheiros privados)

IMPORTANTE: guarde secrets-prod/_all/backup.key e secrets-prod/_all/files.key FORA
deste computador (gestor de senhas). Sem elas, as cópias de segurança e os
comprovativos de pagamento de produção ficam ilegíveis.
EOF
