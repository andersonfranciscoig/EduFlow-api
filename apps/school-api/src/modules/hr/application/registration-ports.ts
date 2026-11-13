import type { RequestInput, RequestStatus } from "../domain/registration";

export interface InviteRow {
  id: string;
  employeeTypeId: string | null;
  employeeTypeName: string | null;
  expiresAt: Date;
  sentAt: Date | null;
  sendError: string | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface RequestRow {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  employeeTypeId: string | null;
  employeeTypeName: string | null;
  status: RequestStatus;
  termsAcceptedAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
  /** o convite ativo (não revogado), se houver */
  invite: InviteRow | null;
}

export interface HistoryRow {
  fromStatus: string | null;
  toStatus: string;
  actorName: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface NewInvite {
  id: string;
  tokenHash: string;
  employeeTypeId: string | null;
  expiresAt: Date;
}

export interface Decision {
  id: string;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  now: Date;
}

/** Mudança de estado guardada com o pedido bloqueado: falha se o estado já não for o esperado. */
export type DecisionOutcome<T = RequestRow> = { ok: true; value: T } | { ok: false; reason: "not_found" | "state"; status?: RequestStatus };

/** Pedidos de cadastro e convites — na BD do PRÓPRIO colégio. */
export interface RegistrationRepository {
  /** Falha com "duplicate" se o email já tiver um pedido em aberto (pendente ou aprovado). */
  createRequest(input: Omit<RequestInput, "password"> & { id: string; passwordHash: string; ip: string | null; userAgent: string | null; now: Date }): Promise<{ ok: true; value: RequestRow } | { ok: false; reason: "duplicate" }>;
  list(input: { status: RequestStatus | null; q: string | null; page: number; pageSize: number }): Promise<{ items: RequestRow[]; total: number; counts: Record<RequestStatus, number> }>;
  find(id: string): Promise<RequestRow | null>;
  history(id: string): Promise<HistoryRow[]>;

  /** PENDING → APPROVED, com o tipo confirmado e o primeiro convite (numa transação). */
  approve(decision: Decision & { employeeTypeId: string | null; invite: NewInvite }): Promise<DecisionOutcome>;
  /** PENDING → REJECTED. */
  reject(decision: Decision): Promise<DecisionOutcome>;
  /** PENDING ou APPROVED → CANCELLED (o convite ativo deixa de valer). */
  cancel(decision: Decision): Promise<DecisionOutcome>;
  /** Pedido APPROVED: revoga o convite ativo e cria outro (novo token, nova validade). */
  reissueInvite(input: { requestId: string; actorId: string | null; invite: NewInvite; now: Date }): Promise<DecisionOutcome>;
  markInviteSent(inviteId: string, now: Date): Promise<void>;
  markInviteFailed(inviteId: string, error: string): Promise<void>;

  /** Quem recebe o aviso de novo pedido: utilizadores ativos que veem pedidos, e o responsável. */
  hrRecipients(): Promise<{ email: string; name: string }[]>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

export interface School {
  slug: string;
  name: string;
}

/** Emails do cadastro (Brevo em produção; consola em desenvolvimento e testes). */
export interface RegistrationMailer {
  requestReceived(input: { to: { email: string; name: string }; school: School }): Promise<void>;
  /** Pediu outra vez com um email que já tem pedido em aberto (a página pública não o revela). */
  requestAlreadyOpen(input: { to: { email: string; name: string }; school: School }): Promise<void>;
  newRequestForHr(input: { to: { email: string; name: string }[]; school: School; applicant: string; employeeType: string | null }): Promise<void>;
  invite(input: { to: { email: string; name: string }; school: School; token: string; expiresAt: Date; employeeType: string | null }): Promise<void>;
  rejected(input: { to: { email: string; name: string }; school: School; reason: string | null }): Promise<void>;
}
