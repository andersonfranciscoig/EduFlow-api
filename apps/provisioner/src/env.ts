import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Ambiente do provisioner. Tem permissão para CRIAR bases de dados e
 * utilizadores, mas não para ler dados da plataforma nem dos colégios.
 * Só conhece a chave PÚBLICA das credenciais (cifra, não decifra).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PROVISIONER_DATABASE_URL: z.string().min(1),
  TENANT_DB_HOST: z.string().min(1),
  TENANT_DB_PORT: z.coerce.number().int().positive(),
  TENANT_CREDENTIALS_PUBLIC_KEY_FILE: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
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
  return parsed.data;
}
