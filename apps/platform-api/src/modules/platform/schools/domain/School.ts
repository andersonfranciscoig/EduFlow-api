import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "./errors";
import type { SchoolLogo } from "./logo";
import { CORPORATE_EMAIL_DEADLINE_DAYS, isPersonalEmail, type OwnerData, type SchoolData } from "./school-data";

export type SchoolStatus = "PENDING_REVIEW" | "AWAITING_PAYMENT" | "PAYMENT_UNDER_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED";

const DAY_MS = 86_400_000;
export type OrderStatus = "PENDING_REVIEW" | "AWAITING_PAYMENT" | "PROOF_SUBMITTED" | "PAID" | "CANCELLED";
export type PaymentMethod = "REFERENCE" | "TRANSFER";

export type SchoolActivityType =
  | "SCHOOL_REGISTERED"
  | "SCHOOL_APPROVED"
  | "SCHOOL_REJECTED"
  | "PAYMENT_METHOD_CHANGED"
  | "PROOF_SUBMITTED"
  | "PROOF_REJECTED"
  | "PAYMENT_CONFIRMED"
  | "SCHOOL_ACTIVATED"
  | "OWNER_PASSWORD_RESET"
  | "OWNER_EMAIL_CHANGED"
  | "SCHOOL_SUSPENDED"
  | "SCHOOL_REACTIVATED"
  | "LOGO_CHANGED"
  | "LOGO_REMOVED";

export interface SchoolEvent {
  type: SchoolActivityType;
  actorStaffId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
}

/** Instruções de pagamento escolhidas pela equipa na validação. */
export type PaymentInstructions =
  | { method: "REFERENCE"; entity: string; reference: string; expiresAt: Date }
  | { method: "TRANSFER"; bankName: string; holder: string; iban: string };

export interface TransferProof {
  transactionNumber: string;
  fileKey: string;
  fileName: string;
  mimeType: string;
  submittedAt: Date;
}

export interface SubscriptionOrder {
  id: string;
  number: string;
  planId: string;
  planName: string;
  planMonthlyPrice: number;
  /** MONTHLY | QUARTERLY | ANNUAL | CUSTOM */
  cycle: string;
  months: number;
  subtotal: number;
  discountPct: number;
  total: number;
  status: OrderStatus;
  instructions: PaymentInstructions | null;
  proof: TransferProof | null;
  proofRejectionReason: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface SchoolProps extends SchoolData {
  id: string;
  /** Identificador público (futuro subdomínio do portal). */
  slug: string | null;
  ownerName: string;
  ownerEmail: string;
  ownerPasswordHash: string;
  status: SchoolStatus;
  rejectionReason: string | null;
  subscriptionEndsAt: Date | null;
  /** Email pessoal: até quando tem de passar a um email corporativo (null = já é corporativo). */
  ownerEmailDeadline: Date | null;
  /** Desativado: quando, porquê e em que estado estava (para reativar). */
  suspendedAt: Date | null;
  suspensionReason: string | null;
  suspendedFromStatus: SchoolStatus | null;
  /** Logótipo público (null = ainda não tem). */
  logo: SchoolLogo | null;
  createdAt: Date;
  /** Da mais recente para a mais antiga. */
  orders: SubscriptionOrder[];
}

function addMonths(date: Date, months: number) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Agregado raiz: colégio cliente da EduFlow.
 * Controla o ciclo de vida do pedido de adesão, da subscrição e do pagamento:
 *
 *   PENDING_REVIEW ──aprovar──▶ AWAITING_PAYMENT ──referência paga──────────▶ ACTIVE
 *        │                          │   ▲                                      ▲
 *     rejeitar                comprovativo│ comprovativo rejeitado            │
 *        ▼                          ▼   │                                      │
 *     REJECTED              PAYMENT_UNDER_REVIEW ──── transferência confirmada ┘
 */
export class School {
  private events: SchoolEvent[] = [];

  private constructor(private props: SchoolProps) {}

  static register(input: {
    id: string;
    slug: string;
    data: SchoolData;
    owner: OwnerData;
    ownerPasswordHash: string;
    order: Omit<SubscriptionOrder, "status" | "instructions" | "proof" | "proofRejectionReason" | "paidAt">;
    now: Date;
  }): School {
    const school = new School({
      id: input.id,
      slug: input.slug,
      ...input.data,
      ownerName: input.owner.name,
      ownerEmail: input.owner.email,
      ownerPasswordHash: input.ownerPasswordHash,
      status: "PENDING_REVIEW",
      rejectionReason: null,
      subscriptionEndsAt: null,
      // email pessoal é aceite, mas com prazo para passar a corporativo
      ownerEmailDeadline: isPersonalEmail(input.owner.email) ? new Date(input.now.getTime() + CORPORATE_EMAIL_DEADLINE_DAYS * DAY_MS) : null,
      suspendedAt: null,
      suspensionReason: null,
      suspendedFromStatus: null,
      logo: null,
      createdAt: input.now,
      orders: [{ ...input.order, status: "PENDING_REVIEW", instructions: null, proof: null, proofRejectionReason: null, paidAt: null }],
    });
    school.record("SCHOOL_REGISTERED", null, input.now, {
      plan: input.order.planName,
      months: input.order.months,
      total: input.order.total,
      ...(school.props.ownerEmailDeadline && { personalEmail: true, emailDeadline: school.props.ownerEmailDeadline.toISOString() }),
    });
    return school;
  }

  // ================================================================ desativar / reativar

  /**
   * Desativa o colégio (equipa, ou automaticamente quando o prazo do email
   * corporativo passa). O portal do colégio deixa de estar acessível.
   */
  suspend(reason: string, staffId: string | null, now: Date): Result<void, SchoolError> {
    if (this.props.status === "SUSPENDED") return fail(schoolError("INVALID_STATE", "Este colégio já está desativado."));
    if (this.props.status === "REJECTED") return fail(schoolError("INVALID_STATE", "Um pedido rejeitado não pode ser desativado."));
    const text = reason.trim();
    if (text.length < 5) return fail(schoolError("INVALID_STATE", "Indique o motivo."));
    this.props.suspendedFromStatus = this.props.status;
    this.props.status = "SUSPENDED";
    this.props.suspendedAt = now;
    this.props.suspensionReason = text;
    this.record("SCHOOL_SUSPENDED", staffId, now, { reason: text, automatic: staffId === null });
    return ok(undefined);
  }

  /**
   * Reativa e volta ao estado anterior. Se ainda usa email pessoal com o prazo
   * já passado, a equipa dá-lhe um novo prazo de 30 dias.
   */
  reactivate(staffId: string, now: Date): Result<void, SchoolError> {
    if (this.props.status !== "SUSPENDED") return fail(schoolError("INVALID_STATE", "Este colégio não está desativado."));
    this.props.status = this.props.suspendedFromStatus ?? "AWAITING_PAYMENT";
    this.props.suspendedAt = null;
    this.props.suspensionReason = null;
    this.props.suspendedFromStatus = null;
    if (this.props.ownerEmailDeadline && this.props.ownerEmailDeadline <= now) {
      this.props.ownerEmailDeadline = new Date(now.getTime() + CORPORATE_EMAIL_DEADLINE_DAYS * DAY_MS);
    }
    this.record("SCHOOL_REACTIVATED", staffId, now, {
      status: this.props.status,
      ...(this.props.ownerEmailDeadline && { emailDeadline: this.props.ownerEmailDeadline.toISOString() }),
    });
    return ok(undefined);
  }

  /** O prazo para o email corporativo passou (e ainda está por desativar)? */
  emailDeadlinePassed(now: Date): boolean {
    return !!this.props.ownerEmailDeadline && this.props.ownerEmailDeadline <= now && this.props.status !== "SUSPENDED" && this.props.status !== "REJECTED";
  }

  /** Troca o email do responsável por um email CORPORATIVO já confirmado com código. */
  changeOwnerEmail(email: string, now: Date): Result<void, SchoolError> {
    if (isPersonalEmail(email)) return fail(schoolError("INVALID_OWNER", "Use o email corporativo do colégio, não um email pessoal."));
    if (email === this.props.ownerEmail) return fail(schoolError("INVALID_STATE", "Este já é o email da conta."));
    const previous = this.props.ownerEmail;
    this.props.ownerEmail = email;
    this.props.ownerEmailDeadline = null;
    this.record("OWNER_EMAIL_CHANGED", null, now, { from: previous, to: email });
    return ok(undefined);
  }

  // ================================================================ logótipo

  /**
   * O responsável (staffId null) só muda o logótipo enquanto a conta está em
   * uso; a equipa pode sempre. Devolve a chave do logótipo anterior (para apagar).
   */
  canEditLogo(staffId: string | null): Result<void, SchoolError> {
    if (staffId) return ok(undefined);
    if (this.props.status === "REJECTED") return fail(schoolError("INVALID_STATE", "Este pedido não foi aprovado."));
    return this.ensureNotSuspended();
  }

  changeLogo(logo: SchoolLogo, staffId: string | null, now: Date): Result<string | null, SchoolError> {
    const allowed = this.canEditLogo(staffId);
    if (!allowed.ok) return allowed;
    const previous = this.props.logo?.key ?? null;
    this.props.logo = { ...logo };
    this.record("LOGO_CHANGED", staffId, now, { replaced: previous !== null });
    return ok(previous);
  }

  removeLogo(staffId: string | null, now: Date): Result<string, SchoolError> {
    const allowed = this.canEditLogo(staffId);
    if (!allowed.ok) return allowed;
    if (!this.props.logo) return fail(schoolError("LOGO_NOT_FOUND", "O colégio não tem logótipo."));
    const previous = this.props.logo.key;
    this.props.logo = null;
    this.record("LOGO_REMOVED", staffId, now, null);
    return ok(previous);
  }

  private ensureNotSuspended(): Result<void, SchoolError> {
    return this.props.status === "SUSPENDED"
      ? fail(schoolError("INVALID_STATE", "Este colégio está desativado. Fale com a equipa EduFlow."))
      : ok(undefined);
  }

  static restore(props: SchoolProps): School {
    return new School({ ...props, logo: props.logo ? { ...props.logo } : null, orders: props.orders.map((o) => ({ ...o })) });
  }

  // ================================================================ equipa

  /** A equipa valida os dados e define como o colégio vai pagar. */
  approve(instructions: PaymentInstructions, staffId: string, now: Date): Result<void, SchoolError> {
    if (this.props.status !== "PENDING_REVIEW") {
      return fail(schoolError("INVALID_STATE", "Este pedido já foi analisado."));
    }
    const order = this.currentOrder!;
    order.status = "AWAITING_PAYMENT";
    order.instructions = instructions;
    this.props.status = "AWAITING_PAYMENT";
    this.record("SCHOOL_APPROVED", staffId, now, { method: instructions.method });
    return ok(undefined);
  }

  reject(reason: string, staffId: string, now: Date): Result<void, SchoolError> {
    if (this.props.status !== "PENDING_REVIEW") {
      return fail(schoolError("INVALID_STATE", "Só é possível rejeitar pedidos por validar."));
    }
    const text = reason.trim();
    if (text.length < 5) return fail(schoolError("INVALID_STATE", "Indique o motivo da rejeição."));
    this.props.status = "REJECTED";
    this.props.rejectionReason = text;
    this.currentOrder!.status = "CANCELLED";
    this.record("SCHOOL_REJECTED", staffId, now, { reason: text });
    return ok(undefined);
  }

  /** Trocar a forma de pagamento (ex.: referência expirou, ou o colégio pediu transferência). */
  changePaymentMethod(instructions: PaymentInstructions, staffId: string, now: Date): Result<void, SchoolError> {
    const order = this.currentOrder;
    if (this.props.status !== "AWAITING_PAYMENT" || order?.status !== "AWAITING_PAYMENT") {
      return fail(schoolError("INVALID_STATE", "Só é possível alterar a forma de pagamento enquanto se aguarda o pagamento."));
    }
    order.instructions = instructions;
    order.proofRejectionReason = null;
    this.record("PAYMENT_METHOD_CHANGED", staffId, now, { method: instructions.method });
    return ok(undefined);
  }

  /** Transferência verificada com o banco → pagamento confirmado. */
  confirmTransferPayment(staffId: string, now: Date): Result<void, SchoolError> {
    const allowed = this.ensureNotSuspended();
    if (!allowed.ok) return allowed;
    const order = this.currentOrder;
    if (order?.status !== "PROOF_SUBMITTED") {
      return fail(schoolError("INVALID_STATE", "Não há nenhum comprovativo por verificar."));
    }
    this.markPaid(order, "TRANSFER", staffId, now);
    return ok(undefined);
  }

  rejectTransferProof(reason: string, staffId: string, now: Date): Result<void, SchoolError> {
    const allowed = this.ensureNotSuspended();
    if (!allowed.ok) return allowed;
    const order = this.currentOrder;
    if (order?.status !== "PROOF_SUBMITTED") {
      return fail(schoolError("INVALID_STATE", "Não há nenhum comprovativo por verificar."));
    }
    const text = reason.trim();
    if (text.length < 5) return fail(schoolError("INVALID_STATE", "Indique o motivo da rejeição."));
    order.status = "AWAITING_PAYMENT";
    order.proofRejectionReason = text;
    order.proof = null;
    this.props.status = "AWAITING_PAYMENT";
    this.record("PROOF_REJECTED", staffId, now, { reason: text });
    return ok(undefined);
  }

  // ================================================================ responsável

  /** Nova senha do responsável (depois de confirmar um código enviado para o email corporativo). */
  resetOwnerPassword(passwordHash: string, now: Date): void {
    this.props.ownerPasswordHash = passwordHash;
    this.record("OWNER_PASSWORD_RESET", null, now, null);
  }

  // ================================================================ colégio / gateway

  /** O colégio envia o nº da transação e o comprovativo (validação manual). */
  submitTransferProof(proof: TransferProof, now: Date): Result<void, SchoolError> {
    const allowed = this.ensureNotSuspended();
    if (!allowed.ok) return allowed;
    const order = this.currentOrder;
    if (order?.status !== "AWAITING_PAYMENT" || order.instructions?.method !== "TRANSFER") {
      return fail(schoolError("INVALID_STATE", "De momento não há nenhuma transferência por comprovar."));
    }
    const transactionNumber = proof.transactionNumber.trim();
    if (transactionNumber.length < 4) {
      return fail(schoolError("INVALID_PROOF", "Indique o número da transação."));
    }
    order.proof = { ...proof, transactionNumber };
    order.proofRejectionReason = null;
    order.status = "PROOF_SUBMITTED";
    this.props.status = "PAYMENT_UNDER_REVIEW";
    this.record("PROOF_SUBMITTED", null, now, { transactionNumber });
    return ok(undefined);
  }

  /** Confirmação automática vinda do gateway de pagamentos por referência. */
  confirmReferencePayment(input: { reference: string; amount: number }, now: Date): Result<void, SchoolError> {
    const allowed = this.ensureNotSuspended();
    if (!allowed.ok) return allowed;
    const order = this.currentOrder;
    const ins = order?.instructions;
    if (!order || order.status !== "AWAITING_PAYMENT" || ins?.method !== "REFERENCE" || ins.reference !== input.reference) {
      return fail(schoolError("REFERENCE_NOT_FOUND", "Referência não encontrada ou já paga."));
    }
    if (ins.expiresAt < now) {
      return fail(schoolError("REFERENCE_EXPIRED", "Esta referência expirou. Peça uma nova à equipa EduFlow."));
    }
    if (input.amount !== order.total) {
      return fail(schoolError("AMOUNT_MISMATCH", "O valor pago não corresponde ao valor da referência.", { expected: order.total }));
    }
    this.markPaid(order, "REFERENCE", null, now);
    return ok(undefined);
  }

  private markPaid(order: SubscriptionOrder, method: PaymentMethod, staffId: string | null, now: Date) {
    order.status = "PAID";
    order.paidAt = now;
    const base = this.props.subscriptionEndsAt && this.props.subscriptionEndsAt > now ? this.props.subscriptionEndsAt : now;
    this.props.subscriptionEndsAt = addMonths(base, order.months);
    this.props.status = "ACTIVE";
    this.record("PAYMENT_CONFIRMED", staffId, now, { method, amount: order.total, automatic: method === "REFERENCE" });
    this.record("SCHOOL_ACTIVATED", staffId, now, { until: this.props.subscriptionEndsAt.toISOString() });
  }

  // ================================================================ eventos

  private record(type: SchoolActivityType, actorStaffId: string | null, now: Date, details: Record<string, unknown> | null) {
    this.events.push({ type, actorStaffId, details, occurredAt: now });
  }

  pullEvents(): SchoolEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  // ================================================================ leitura

  get id() { return this.props.id; }
  get slug() { return this.props.slug; }
  get status() { return this.props.status; }
  get ownerEmail() { return this.props.ownerEmail; }
  get ownerEmailDeadline() { return this.props.ownerEmailDeadline; }
  get ownerPasswordHash() { return this.props.ownerPasswordHash; }
  get currentOrder(): SubscriptionOrder | undefined { return this.props.orders[0]; }
  get snapshot(): Readonly<SchoolProps> { return this.props; }
}
