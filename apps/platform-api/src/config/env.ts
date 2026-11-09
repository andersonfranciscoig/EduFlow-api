import { z } from "zod";
import { envValidator } from "../../../../libs/kernel/src/infrastructure/env";

/**
 * Ambiente do platform-api. Repare no que NÃO está aqui: nenhuma credencial
 * das bases de dados dos colégios e nenhuma chave do school-api.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default("http://localhost:3001"),
  /** Utilizador eduflow_platform_app (só dados, sem DDL). */
  PLATFORM_DATABASE_URL: z.string().min(1),
  STAFF_JWT_PRIVATE_KEY_FILE: z.string().min(1),
  STAFF_JWT_PUBLIC_KEY_FILE: z.string().min(1),
  CUSTOMER_JWT_PRIVATE_KEY_FILE: z.string().min(1),
  CUSTOMER_JWT_PUBLIC_KEY_FILE: z.string().min(1),
  /** Chave AES-256 (base64) que cifra os segredos TOTP na BD. */
  MFA_ENCRYPTION_KEY_FILE: z.string().min(1),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEFAULT_PHONE_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default("244"),
  /** Pasta onde se guardam ficheiros enviados (ex.: comprovativos). */
  STORAGE_DIR: z.string().default("./storage/platform"),
});

export type Env = z.infer<typeof envSchema>;

export const validateEnv = envValidator(envSchema, "platform-api");
