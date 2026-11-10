import { z } from "zod";
import { STAFF_ROLES, STAFF_STATUSES } from "../../domain/access-control";

/**
 * Contratos HTTP do contexto Identity.
 * - Schemas de ENTRADA: validam forma (tipos/tamanhos) e documentam o pedido.
 *   As regras de negócio (formato de email, política de senha…) ficam no domínio.
 * - Schemas de SAÍDA: apenas documentação (Swagger).
 */

const identifier = z
  .string({ error: "Indique o email ou telefone." })
  .trim()
  .min(1, "Indique o email ou telefone.")
  .max(254)
  .meta({ description: "Email ou número de telefone", example: "ana@eduflow.ao" });

const password = z
  .string({ error: "Indique a senha." })
  .max(128)
  .meta({ description: "Senha", example: "Senha1234" });

// ------------------------------------------------------------------ entrada

export const identifySchema = z.object({ identifier }).meta({ title: "IdentifyRequest" });

export const signInSchema = z
  .object({ identifier, password: password.min(1, "Indique a senha.") })
  .meta({ title: "SignInRequest" });

export const signUpSchema = z
  .object({
    identifier,
    fullName: z
      .string({ error: "Indique o seu nome." })
      .trim()
      .min(1, "Indique o seu nome.")
      .max(120)
      .meta({ example: "Ana Paula Domingos" }),
    password: password.meta({ description: "8+ caracteres, com letras e números", example: "Senha1234" }),
    emailProof: z
      .string()
      .min(20, "Confirme primeiro o seu email.")
      .max(200)
      .optional()
      .meta({ description: "Devolvido por POST sign-up/code/verify (30 min, uso único). Não é preciso com inviteToken." }),
    inviteToken: z.string().min(20).max(200).optional().meta({ description: "Token do link do convite (o link prova o email)" }),
  })
  .meta({ title: "SignUpRequest" });

export const invitationLookupSchema = z.object({ token: z.string({ error: "Convite inválido." }).min(20, "Convite inválido.").max(200) }).meta({ title: "InvitationLookup" });
export const inviteSchema = z
  .object({
    email: z.string({ error: "Indique o email." }).trim().min(1, "Indique o email.").max(254).meta({ example: "maria@eduflow.ao" }),
    role: z.enum(STAFF_ROLES, { error: "Escolha o papel." }),
  })
  .meta({ title: "StaffInvite" });
export type InviteBody = z.infer<typeof inviteSchema>;

// ------------------------------------------------------------------ códigos por email

const email = z.string({ error: "Indique o email." }).trim().min(1, "Indique o email.").max(254).meta({ example: "ana@eduflow.ao" });
const emailCode = z.string({ error: "Indique o código." }).trim().regex(/^\d{6}$/, "O código tem 6 dígitos.").meta({ example: "482913" });
const ticket = z.string({ error: "Pedido inválido." }).min(20, "Pedido inválido.").max(200);

export const signUpCodeSchema = z.object({ email }).meta({ title: "SignUpCodeRequest" });
export const signUpCodeVerifySchema = z.object({ email, code: emailCode }).meta({ title: "SignUpCodeVerify" });
export const resetCodeSchema = z.object({ identifier }).meta({ title: "PasswordResetCodeRequest" });
export const resetVerifySchema = z.object({ identifier, code: emailCode }).meta({ title: "PasswordResetCodeVerify" });
export const resetPasswordSchema = z
  .object({ identifier, ticket, password: password.min(1, "Indique a nova senha.") })
  .meta({ title: "PasswordReset" });

export const codeSentSchema = z
  .object({ destination: z.string().nullable().meta({ description: "Email mascarado (null: resposta igual se a conta não existir)" }) })
  .meta({ title: "EmailCodeSent" });

export type SignUpCodeBody = z.infer<typeof signUpCodeSchema>;
export type SignUpCodeVerifyBody = z.infer<typeof signUpCodeVerifySchema>;
export type ResetCodeBody = z.infer<typeof resetCodeSchema>;
export type ResetVerifyBody = z.infer<typeof resetVerifySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;

const challengeToken = z
  .string({ error: "Pedido inválido. Volte a introduzir a senha." })
  .min(20, "Pedido inválido. Volte a introduzir a senha.")
  .max(2000)
  .meta({ description: "Bilhete devolvido pelo sign-in (válido 10 min)" });

const mfaCode = z
  .string({ error: "Indique o código." })
  .trim()
  .min(6, "Indique o código de 6 dígitos.")
  .max(20)
  .meta({ description: "Código de 6 dígitos da app, ou código de recuperação (xxxx-xxxx)", example: "123456" });

export const challengeSchema = z.object({ challengeToken }).meta({ title: "MfaChallenge" });
export const challengeCodeSchema = z.object({ challengeToken, code: mfaCode }).meta({ title: "MfaChallengeCode" });
export const stepUpSchema = z.object({ code: mfaCode }).meta({ title: "MfaStepUp" });
export const sessionIdSchema = z.uuid({ error: "Sessão inválida." });

export type IdentifyBody = z.infer<typeof identifySchema>;
export type SignInBody = z.infer<typeof signInSchema>;
export type SignUpBody = z.infer<typeof signUpSchema>;
export type ChallengeBody = z.infer<typeof challengeSchema>;
export type ChallengeCodeBody = z.infer<typeof challengeCodeSchema>;
export type StepUpBody = z.infer<typeof stepUpSchema>;

// ------------------------------------------------------------------ saída (docs)

const staffPrincipal = z.object({
  id: z.uuid(),
  fullName: z.string().meta({ example: "Ana Paula Domingos" }),
  role: z.enum(STAFF_ROLES),
});

export const identifyResponseSchema = z
  .object({
    exists: z.boolean(),
    kind: z.enum(["email", "phone"]),
    normalized: z.string().meta({ description: "Email em minúsculas ou telefone E.164", example: "+244923456789" }),
    firstName: z.string().nullable().meta({ example: "Ana" }),
  })
  .meta({ title: "IdentifyResponse" });

export const sessionResponseSchema = z
  .object({
    staff: staffPrincipal,
    accessToken: z.string().meta({ description: "JWT (Bearer)" }),
    expiresIn: z.number().int().meta({ description: "Segundos até expirar", example: 28800 }),
  })
  .meta({ title: "SessionResponse" });

export const loginStepSchema = z
  .object({
    status: z.enum(["MFA_REQUIRED", "MFA_SETUP_REQUIRED"]).meta({
      description: "A senha está certa; falta a 2FA (verificar código, ou configurar se for a primeira vez)",
    }),
    challengeToken: z.string(),
    firstName: z.string(),
  })
  .meta({ title: "LoginStep" });

export const signUpResponseSchema = z
  .object({
    role: z.enum(STAFF_ROLES),
    status: z.enum([...STAFF_STATUSES, "MFA_SETUP_REQUIRED"]).meta({
      description: "Primeiro membro: MFA_SETUP_REQUIRED (configura a 2FA e entra). Restantes: PENDING_APPROVAL.",
    }),
    challengeToken: z.string().optional(),
    firstName: z.string(),
  })
  .meta({ title: "SignUpResponse" });

export const mfaSetupSchema = z
  .object({
    secret: z.string().meta({ description: "Chave para introduzir manualmente na app" }),
    otpauthUrl: z.string().meta({ description: "Conteúdo do QR code" }),
    account: z.string(),
  })
  .meta({ title: "MfaSetup" });

export const mfaConfirmResponseSchema = sessionResponseSchema
  .extend({ recoveryCodes: z.array(z.string()).meta({ description: "Mostrados UMA única vez" }) })
  .meta({ title: "MfaConfirmed" });

export const securitySchema = z
  .object({
    mfaEnabled: z.boolean(),
    mfaEnabledAt: z.string().nullable(),
    recoveryCodesLeft: z.number().int(),
    sessions: z.array(
      z.object({
        id: z.uuid(),
        current: z.boolean(),
        ip: z.string().nullable(),
        userAgent: z.string().nullable(),
        createdAt: z.string(),
        lastSeenAt: z.string(),
        expiresAt: z.string(),
      }),
    ),
  })
  .meta({ title: "AccountSecurity" });
