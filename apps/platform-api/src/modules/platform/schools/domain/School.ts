import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "./errors";
import type { OwnerData, SchoolData } from "./school-data";

export type SchoolStatus = "PENDING_REVIEW" | "AWAITING_PAYMENT" | "PAYMENT_UNDER_REVIEW" | "ACTIVE" | "REJECTED";
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
  | "SCHOOL_ACTIVATED";

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
      createdAt: input.now,
      orders: [{ ...input.order, status: "PENDING_REVIEW", instructions: null, proof: null, proofRejectionReason: null, paidAt: null }],
    });
    school.record("SCHOOL_REGISTERED", null, input.now, {
      plan: input.order.planName,
      months: input.order.months,
      total: input.order.total,
    });
    return school;
  }

  static restore(props: SchoolProps): School {
    return new School({ ...props, orders: props.orders.map((o) => ({ ...o })) });
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
    const order = this.currentOrder;
    if (order?.status !== "PROOF_SUBMITTED") {
      return fail(schoolError("INVALID_STATE", "Não há nenhum comprovativo por verificar."));
    }
    this.markPaid(order, "TRANSFER", staffId, now);
    return ok(undefined);
  }

  rejectTransferProof(reason: string, staffId: string, now: Date): Result<void, SchoolError> {
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

  // ================================================================ colégio / gateway

  /** O colégio envia o nº da transação e o comprovativo (validação manual). */
  submitTransferProof(proof: TransferProof, now: Date): Result<void, SchoolError> {
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
  get ownerPasswordHash() { return this.props.ownerPasswordHash; }
  get currentOrder(): SubscriptionOrder | undefined { return this.props.orders[0]; }
  get snapshot(): Readonly<SchoolProps> { return this.props; }
}
