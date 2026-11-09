import { z } from "zod";
import { envValidator } from "../../../../libs/kernel/src/infrastructure/env";

/**
 * Ambiente do school-api. Repare no que NÃO está aqui: nenhuma credencial da
 * base de dados da plataforma (só um utilizador que lê o diretório) e
 * nenhuma chave de tokens da equipa EduFlow.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4001),
  /** Utilizador eduflow_school_directory — só lê tenant_databases. */
  DIRECTORY_DATABASE_URL: z.string().min(1),
  /** Chave privada que decifra as credenciais das BDs dos colégios (só existe aqui). */
  TENANT_CREDENTIALS_PRIVATE_KEY_FILE: z.string().min(1),
  /** Máximo de ligações a colégios mantidas abertas em memória. */
  TENANT_POOL_SIZE: z.coerce.number().int().min(1).default(50),
});

export type Env = z.infer<typeof envSchema>;

export const validateEnv = envValidator(envSchema, "school-api");
