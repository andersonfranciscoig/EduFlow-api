import { z } from "zod";
import { SCHOOL_ROLES } from "../../domain/SchoolUser";

/**
 * Contratos HTTP da identidade do portal. Os schemas de ENTRADA validam forma
 * (tipos/tamanhos); as regras (formato do email, política de senha…) ficam no
 * domínio. Os de SAÍDA servem só para a documentação (Swagger).
 */
const identifier = z
  .string({ error: "Indique o email ou telefone." })
  .trim()
  .min(1, "Indique o email ou telefone.")
  .max(254)
  .meta({ description: "Email ou número de telefone", example: "diretora@colegio.ao" });

const password = z.string({ error: "Indique a senha." }).min(1, "Indique a senha.").max(128).meta({ example: "Senha1234" });

const ticket = z
  .string({ error: "Pedido inválido." })
  .min(20, "Pedido inválido.")
  .max(2000)
  .meta({ description: "Bilhete de 10 minutos devolvido pelo passo anterior" });

const mfaCode = z
  .string({ error: "Indique o código." })
  .trim()
  .min(6, "Indique o código de 6 dígitos.")
  .max(20)
  .meta({ description: "6 dígitos da app, ou código de recuperação (xxxx-xxxx)", example: "123456" });

const codePurpose = z.enum(["activation", "password-reset"]).meta({ description: "Ativar a conta ou repor a senha" });

export const identifySchema = z.object({ identifier }).meta({ title: "IdentifyRequest" });
export const signInSchema = z.object({ identifier, password }).meta({ title: "SignInRequest" });
export const sendCodeSchema = z.object({ identifier, purpose: codePurpose }).meta({ title: "SendEmailCode" });
export const verifyCodeSchema = z
  .object({
    identifier,
    purpose: codePurpose,
    code: z.string({ error: "Indique o código." }).trim().regex(/^\d{6}$/, "O código tem 6 dígitos.").meta({ example: "482913" }),
  })
  .meta({ title: "VerifyEmailCode" });
export const setPasswordSchema = z.object({ ticket, password }).meta({ title: "SetPassword" });
export const challengeSchema = z.object({ challengeToken: ticket }).meta({ title: "MfaChallenge" });
export const challengeCodeSchema = z.object({ challengeToken: ticket, code: mfaCode }).meta({ title: "MfaChallengeCode" });

export type IdentifyBody = z.infer<typeof identifySchema>;
export type SignInBody = z.infer<typeof signInSchema>;
export type SendCodeBody = z.infer<typeof sendCodeSchema>;
export type VerifyCodeBody = z.infer<typeof verifyCodeSchema>;
export type SetPasswordBody = z.infer<typeof setPasswordSchema>;
export type ChallengeBody = z.infer<typeof challengeSchema>;
export type ChallengeCodeBody = z.infer<typeof challengeCodeSchema>;

// ------------------------------------------------------------------ saída (docs)

export const identifyResponseSchema = z
  .object({
    exists: z.boolean(),
    kind: z.enum(["email", "phone"]),
    normalized: z.string().meta({ example: "diretora@colegio.ao" }),
    firstName: z.string().nullable(),
    activationRequired: z.boolean().meta({ description: "Conta criada mas por ativar (código por email)" }),
  })
  .meta({ title: "IdentifyResponse" });

export const loginStepSchema = z
  .object({
    status: z.enum(["MFA_REQUIRED", "MFA_SETUP_REQUIRED"]),
    challengeToken: z.string(),
    firstName: z.string(),
  })
  .meta({ title: "LoginStep" });

export const sendCodeResponseSchema = z
  .object({ destination: z.string().nullable().meta({ description: "Email mascarado, ou null (resposta igual se a conta não existir)" }) })
  .meta({ title: "EmailCodeSent" });

export const ticketResponseSchema = z.object({ ticket: z.string() }).meta({ title: "Ticket" });

const principal = z.object({ id: z.uuid(), fullName: z.string(), role: z.enum(SCHOOL_ROLES) });

export const sessionResponseSchema = z
  .object({ user: principal, accessToken: z.string(), expiresIn: z.number().int() })
  .meta({ title: "SessionResponse" });

export const mfaSetupSchema = z.object({ secret: z.string(), otpauthUrl: z.string(), account: z.string() }).meta({ title: "MfaSetup" });

export const mfaConfirmResponseSchema = sessionResponseSchema
  .extend({ recoveryCodes: z.array(z.string()).meta({ description: "Mostrados UMA única vez" }) })
  .meta({ title: "MfaConfirmed" });
