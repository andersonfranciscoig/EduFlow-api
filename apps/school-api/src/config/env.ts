import { z } from "zod";
import { envValidator } from "../../../../libs/kernel/src/infrastructure/env";

/**
 * Ambiente do school-api. Repare no que NÃO está aqui: nenhuma credencial da
 * base de dados da plataforma (só um utilizador que lê o diretório) e
 * nenhuma chave de tokens da equipa EduFlow nem dos responsáveis.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4001),
    /** Utilizador eduflow_school_directory — só lê tenant_databases. */
    DIRECTORY_DATABASE_URL: z.string().min(1),
    /** Chave privada que decifra as credenciais das BDs dos colégios (só existe aqui). */
    TENANT_CREDENTIALS_PRIVATE_KEY_FILE: z.string().min(1),
    /** Máximo de ligações a colégios mantidas abertas em memória. */
    TENANT_POOL_SIZE: z.coerce.number().int().min(1).default(50),
    /**
     * Domínio dos portais (ex.: "eduflow.ao" → colegio-x.eduflow.ao).
     * Só se aceita um colégio vindo do Host quando termina neste domínio.
     */
    TENANT_BASE_DOMAIN: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+$/)
      .optional(),

    // ---------------------------------------------------------------- identidade
    /** Tokens dos utilizadores dos colégios: par ES256 próprio (nem equipa, nem responsáveis). */
    SCHOOL_JWT_PRIVATE_KEY_FILE: z.string().min(1),
    SCHOOL_JWT_PUBLIC_KEY_FILE: z.string().min(1),
    /** AES-256 que cifra os segredos da 2FA guardados nas BDs dos colégios. */
    SCHOOL_MFA_KEY_FILE: z.string().min(1),
    JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    DEFAULT_PHONE_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default("244"),
    /** Endereço do portal nos emails; {slug} é substituído pelo colégio. */
    PORTAL_URL_TEMPLATE: z.string().includes("{slug}").default("http://{slug}.localhost:3002"),
    /**
     * Chave PÚBLICA dos bilhetes de suporte (a privada só existe no platform-api).
     * Com ela o school-api confirma um bilhete, mas não consegue criar nenhum.
     */
    SUPPORT_TICKET_PUBLIC_KEY_FILE: z.string().min(1),
    /** Segredo partilhado com o portal: o IP real do utilizador chega assinado (HMAC). Opcional em dev. */
    CLIENT_IP_SECRET: z.string().min(32, "use pelo menos 32 caracteres").optional(),

    // ---------------------------------------------------------------- email (Brevo)
    EMAIL_PROVIDER: z.enum(["brevo", "console"]).default("console"),
    EMAIL_FROM: z.email().default("noreply@eduflow.ao"),
    EMAIL_FROM_NAME: z.string().min(1).default("EduFlow"),
    EMAIL_REPLY_TO: z.email().default("noreply@eduflow.ao"),
    /** Ficheiro com a chave da API do Brevo (secrets/email-api.key). */
    EMAIL_API_KEY_FILE: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === "brevo" && !env.EMAIL_API_KEY_FILE) {
      ctx.addIssue({ code: "custom", path: ["EMAIL_API_KEY_FILE"], message: "obrigatório com EMAIL_PROVIDER=brevo" });
    }
    if (env.NODE_ENV === "production" && !env.TENANT_BASE_DOMAIN) {
      ctx.addIssue({ code: "custom", path: ["TENANT_BASE_DOMAIN"], message: "obrigatório em produção" });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const validateEnv = envValidator(envSchema, "school-api");
