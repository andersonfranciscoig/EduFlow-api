import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Ambiente do provisioner. Tem permissão para CRIAR bases de dados e
 * utilizadores, mas não para ler dados da plataforma nem dos colégios.
 * Chaves: PÚBLICA das credenciais dos colégios (cifra, não decifra) e PRIVADA
 * dos URLs dos servidores de BD (só ele os consegue abrir).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PROVISIONER_DATABASE_URL: z.string().min(1),
  TENANT_DB_HOST: z.string().min(1),
  TENANT_DB_PORT: z.coerce.number().int().positive(),
  TENANT_CREDENTIALS_PUBLIC_KEY_FILE: z.string().min(1),
  SERVER_CREDENTIALS_PRIVATE_KEY_FILE: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  /** Vigilância periódica de todos os servidores ativos. */
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(30_000).default(300_000),
  /** Acima disto (mediana de 3 pedidos) o servidor é marcado como lento. */
  SLOW_LATENCY_MS: z.coerce.number().int().min(1).default(150),
  // ---------------------------------------------------------------- cópias de segurança
  /** AES-256 (base64) que cifra as cópias ANTES de sair (só o provisioner a tem). */
  BACKUP_KEY_FILE: z.string().min(1),
  /** Onde ficam as cópias: UploadThing (privado) ou uma pasta local (dev sem token). */
  BACKUP_STORAGE: z.enum(["uploadthing", "local"]).default("local"),
  UPLOADTHING_TOKEN_FILE: z.string().min(1).optional(),
  /**
   * "private" exige um plano pago do UploadThing. Em dev (plano grátis) usa-se
   * "public-read": as cópias continuam cifradas (AES-256-GCM) e ilegíveis sem a chave.
   */
  UPLOADTHING_ACL: z.enum(["private", "public-read"]).default("private"),
  BACKUP_LOCAL_DIR: z.string().default("./storage/backups"),
  /**
   * pg_dump tem de ser da versão do servidor (ou mais nova). Em dev, se o do
   * sistema for antigo, corre dentro desta imagem Docker (ex.: postgres:16-alpine).
   */
  PG_DUMP_DOCKER_IMAGE: z.string().min(1).optional(),
  /** De quanto em quanto tempo se mede o tamanho das BDs e se agendam cópias automáticas. */
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  /** SÓ desenvolvimento: colégios sem servidor atribuído usam o cluster local. */
  LOCAL_FALLBACK_SERVER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ProvisionerEnv = z.infer<typeof schema>;

export function loadEnv(): ProvisionerEnv {
  const file = "apps/provisioner/.env";
  if (process.env.NODE_ENV !== "production" && existsSync(file)) process.loadEnvFile(file);
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`[provisioner] Configuração inválida (${file}):\n${issues}`);
  }
  if (parsed.data.BACKUP_STORAGE === "uploadthing" && (!parsed.data.UPLOADTHING_TOKEN_FILE || !existsSync(parsed.data.UPLOADTHING_TOKEN_FILE))) {
    throw new Error("[provisioner] UPLOADTHING_TOKEN_FILE é obrigatório com BACKUP_STORAGE=uploadthing.");
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.BACKUP_STORAGE === "uploadthing" && parsed.data.UPLOADTHING_ACL !== "private") {
    throw new Error("[provisioner] Em produção as cópias têm de ser privadas (UPLOADTHING_ACL=private).");
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.LOCAL_FALLBACK_SERVER) {
    throw new Error("[provisioner] LOCAL_FALLBACK_SERVER não pode ser usado em produção.");
  }
  return parsed.data;
}
