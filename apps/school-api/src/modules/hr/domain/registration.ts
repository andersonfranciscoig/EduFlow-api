import { EmailAddress, FullName, PhoneNumber, PlainPassword } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type HrError, hrError } from "./form";

/**
 * PEDIDO DE CADASTRO → CONVITE.
 *   1. a pessoa pede, na página pública do colégio (nome, email, telefone, função, palavra-passe)
 *   2. o RH aprova (confirma ou corrige a função) ou rejeita, com justificação
 *   3. ao aprovar segue um convite por email: link com um token aleatório, válido INVITE_VALID_DAYS
 *   4. o link + a palavra-passe do pedido dão acesso ao formulário (fase seguinte)
 */
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = { PENDING: "Pendente", APPROVED: "Aprovado", REJECTED: "Rejeitado", CANCELLED: "Cancelado" };
export const REQUEST_STATUSES = Object.keys(REQUEST_STATUS_LABELS) as RequestStatus[];
export const isRequestStatus = (s: string): s is RequestStatus => s in REQUEST_STATUS_LABELS;

export const INVITE_VALID_DAYS = 7;
const DAY_MS = 86_400_000;
export const inviteExpiry = (now: Date) => new Date(now.getTime() + INVITE_VALID_DAYS * DAY_MS);

/** Estado do convite visto de fora: válido, expirado ou substituído/cancelado. */
export type InviteState = "VALID" | "EXPIRED" | "REVOKED";
export const inviteState = (i: { expiresAt: Date; revokedAt: Date | null }, now: Date): InviteState => (i.revokedAt ? "REVOKED" : i.expiresAt <= now ? "EXPIRED" : "VALID");

export interface RequestInput {
  fullName: string;
  email: string;
  phone: string | null;
  password: string;
  employeeTypeId: string | null;
}

export function checkRequest(
  input: { fullName: string; email: string; phone?: string | null; password: string; employeeTypeId?: string | null; acceptTerms: boolean },
  defaultCountryCode: string,
): Result<RequestInput, HrError> {
  if (!input.acceptTerms) return fail(hrError("INVALID_INPUT", "Para pedir o cadastro tem de aceitar o tratamento dos dados."));
  const name = FullName.create(input.fullName);
  if (!name.ok) return fail(hrError("INVALID_INPUT", name.error.message));
  const email = EmailAddress.create(input.email);
  if (!email.ok) return fail(hrError("INVALID_INPUT", email.error.message));
  let phone: string | null = null;
  if (input.phone?.trim()) {
    const p = PhoneNumber.create(input.phone, defaultCountryCode);
    if (!p.ok) return fail(hrError("INVALID_INPUT", p.error.message));
    phone = p.value.value;
  }
  const password = PlainPassword.create(input.password);
  if (!password.ok) return fail(hrError("INVALID_INPUT", password.error.message));
  return ok({ fullName: name.value.value, email: email.value.value, phone, password: password.value.value, employeeTypeId: input.employeeTypeId ?? null });
}

/** Justificação de uma decisão (obrigatória ao rejeitar e ao cancelar). */
export function checkReason(raw: string | null | undefined, required: boolean): Result<string | null, HrError> {
  const reason = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!reason) return required ? fail(hrError("INVALID_INPUT", "Indique a justificação.")) : ok(null);
  if (reason.length < 3 || reason.length > 500) return fail(hrError("INVALID_INPUT", "A justificação tem 3 a 500 caracteres."));
  return ok(reason);
}
