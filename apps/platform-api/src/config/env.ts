import { existsSync } from "node:fs";
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
  /** Chave PÚBLICA do provisioner: sela os URLs dos servidores de BD (a plataforma não os consegue abrir). */
  SERVER_CREDENTIALS_PUBLIC_KEY_FILE: z.string().min(1),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEFAULT_PHONE_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default("244"),
  /** Pasta local: comprovativos antigos (e todos, com FILE_STORAGE=local). */
  STORAGE_DIR: z.string().default("./storage/platform"),

  // ---------------------------------------------------------------- comprovativos de pagamento
  /** UploadThing (cifrados com AES-256-GCM antes de sair) ou pasta local (dev sem token). */
  FILE_STORAGE: z.enum(["uploadthing", "local"]).default("local"),
  FILES_UPLOADTHING_TOKEN_FILE: z.string().min(1).optional(),
  /** "private" exige plano pago; com "public-read" o conteúdo continua cifrado. */
  FILES_UPLOADTHING_ACL: z.enum(["private", "public-read"]).default("private"),
  /** AES-256 (base64) que cifra os comprovativos — só a platform-api a tem. */
  FILES_ENCRYPTION_KEY_FILE: z.string().min(1).optional(),

  // ---------------------------------------------------------------- logótipos (públicos)
  /** UploadThing (ficheiros públicos) ou pasta local servida por esta API (dev sem token). */
  LOGO_STORAGE: z.enum(["uploadthing", "local"]).default("local"),
  /** Token do UploadThing. Em produção: uma app SÓ para ficheiros públicos, não a das cópias. */
  LOGO_UPLOADTHING_TOKEN_FILE: z.string().min(1).optional(),
  /** Endereço público desta API (URLs dos logótipos guardados localmente). */
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000/api"),

  // ---------------------------------------------------------------- suporte aos colégios
  /** Chave PRIVADA dos bilhetes de suporte (a pública está só no school-api). */
  SUPPORT_TICKET_PRIVATE_KEY_FILE: z.string().min(1),

  /** Segredo partilhado com o frontend: o IP real do utilizador chega assinado (HMAC). Opcional em dev. */
  CLIENT_IP_SECRET: z.string().min(32, "use pelo menos 32 caracteres").optional(),

  // ---------------------------------------------------------------- email (Brevo)
  /** Sem chave (console): os emails aparecem no terminal. */
  EMAIL_PROVIDER: z.enum(["brevo", "console"]).default("console"),
  EMAIL_FROM: z.email().default("noreply@eduflow.ao"),
  EMAIL_FROM_NAME: z.string().min(1).default("EduFlow"),
  EMAIL_REPLY_TO: z.email().default("noreply@eduflow.ao"),
  EMAIL_API_KEY_FILE: z.string().min(1).optional(),
  /** Endereço do portal de cada colégio ({slug}) — vai no email de ativação. */
  PORTAL_URL_TEMPLATE: z.string().includes("{slug}").default("http://{slug}.localhost:3002"),
}).superRefine((env, ctx) => {
  if (env.LOGO_STORAGE === "uploadthing" && (!env.LOGO_UPLOADTHING_TOKEN_FILE || !existsSync(env.LOGO_UPLOADTHING_TOKEN_FILE))) {
    ctx.addIssue({ code: "custom", path: ["LOGO_UPLOADTHING_TOKEN_FILE"], message: "obrigatório (ficheiro existente) com LOGO_STORAGE=uploadthing" });
  }
  if (env.FILE_STORAGE === "uploadthing") {
    for (const k of ["FILES_UPLOADTHING_TOKEN_FILE", "FILES_ENCRYPTION_KEY_FILE"] as const) {
      if (!env[k] || !existsSync(env[k])) ctx.addIssue({ code: "custom", path: [k], message: "obrigatório (ficheiro existente) com FILE_STORAGE=uploadthing" });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

export const validateEnv = envValidator(envSchema, "platform-api");
