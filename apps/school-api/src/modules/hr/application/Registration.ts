import { createHash, randomBytes } from "node:crypto";
import type { Clock, IdGenerator, PasswordHasher } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { hrError } from "../domain/form";
import { checkReason, checkRequest, INVITE_VALID_DAYS, inviteExpiry, inviteState, REQUEST_STATUS_LABELS, REQUEST_STATUSES, type RequestStatus } from "../domain/registration";
import type { HrSettingsRepository } from "./ports";
import type { DecisionOutcome, HistoryRow, InviteRow, NewInvite, RegistrationMailer, RegistrationRepository, RequestRow, School } from "./registration-ports";

/** Quem decide (vem da sessão do portal). Numa sessão de suporte não há utilizador do colégio. */
export interface HrActor {
  id: string | null;
  name: string | null;
}

export const PAGE_SIZE = 20;

/** Token do link: 32 bytes aleatórios (256 bits) em base64url. Na BD só fica o SHA-256. */
export const newInviteToken = () => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const inviteDto = (i: InviteRow | null, now: Date) =>
  i && {
    employeeTypeId: i.employeeTypeId,
    employeeTypeName: i.employeeTypeName,
    expiresAt: i.expiresAt.toISOString(),
    sentAt: i.sentAt?.toISOString() ?? null,
    sendError: i.sendError,
    lastUsedAt: i.lastUsedAt?.toISOString() ?? null,
    state: inviteState(i, now),
  };

const requestDto = (r: RequestRow, now: Date) => ({
  id: r.id,
  fullName: r.fullName,
  email: r.email,
  phone: r.phone,
  employeeTypeId: r.employeeTypeId,
  employeeTypeName: r.employeeTypeName,
  status: r.status,
  statusLabel: REQUEST_STATUS_LABELS[r.status],
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  decidedBy: r.decidedBy,
  decisionReason: r.decisionReason,
  invite: inviteDto(r.invite, now),
});

const historyDto = (h: HistoryRow) => ({
  fromStatus: h.fromStatus,
  fromLabel: h.fromStatus && h.fromStatus in REQUEST_STATUS_LABELS ? REQUEST_STATUS_LABELS[h.fromStatus as RequestStatus] : h.fromStatus,
  toStatus: h.toStatus,
  toLabel: h.toStatus in REQUEST_STATUS_LABELS ? REQUEST_STATUS_LABELS[h.toStatus as RequestStatus] : h.toStatus,
  actorName: h.actorName,
  reason: h.reason,
  createdAt: h.createdAt.toISOString(),
});

function decisionError(r: Exclude<DecisionOutcome, { ok: true }>) {
  if (r.reason === "not_found") return hrError("REQUEST_NOT_FOUND", "Pedido não encontrado.");
  const label = r.status ? REQUEST_STATUS_LABELS[r.status].toLowerCase() : "noutro estado";
  return hrError("INVALID_STATE", `O pedido já está ${label}. Recarregue a página.`);
}

/**
 * Pedidos de cadastro de funcionários: a página pública (sem sessão), a análise pelo RH
 * e os convites por email. As permissões do RH exigem-se no controller; as regras aqui.
 * Os emails nunca bloqueiam a operação: um convite que não seguiu fica marcado para reenviar.
 */
export class Registration {
  constructor(
    private readonly mailer: RegistrationMailer,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly defaultCountryCode: string,
  ) {}

  /** O que a página pública precisa: se o colégio já abriu cadastros e os tipos de funcionário. */
  async publicInfo(settings: HrSettingsRepository, school: School) {
    const latest = await settings.latest();
    return { school: school.name, open: !!latest, employeeTypes: latest?.snapshot.employeeTypes ?? [] };
  }

  /**
   * Novo pedido. A resposta é igual quer o email já tenha um pedido em aberto quer não
   * (a página pública não revela quem pediu); nesse caso a pessoa recebe um email a avisar.
   */
  async submit(
    repo: RegistrationRepository,
    settings: HrSettingsRepository,
    school: School,
    input: { fullName: string; email: string; phone?: string | null; password: string; employeeTypeId?: string | null; acceptTerms: boolean },
    client: { ip: string | null; userAgent: string | null },
  ) {
    const latest = await settings.latest();
    if (!latest) return fail(hrError("FORM_NOT_PUBLISHED", "O colégio ainda não abriu os pedidos de cadastro."));
    const checked = checkRequest(input, this.defaultCountryCode);
    if (!checked.ok) return checked;
    const types = latest.snapshot.employeeTypes ?? [];
    if (types.length && !types.some((t) => t.id === checked.value.employeeTypeId)) return fail(hrError("INVALID_INPUT", "Escolha a função a que se candidata."));
    if (!types.length && checked.value.employeeTypeId) return fail(hrError("INVALID_INPUT", "Função inválida."));

    const now = this.clock.now();
    const { password, ...data } = checked.value;
    const created = await repo.createRequest({ ...data, id: this.ids.next(), passwordHash: await this.hasher.hash(password), ip: client.ip, userAgent: client.userAgent, now });
    const to = { email: data.email, name: data.fullName };
    if (!created.ok) {
      await this.quietly(() => this.mailer.requestAlreadyOpen({ to, school }));
      return ok({ received: true });
    }
    await repo.record("HR_REQUEST_SUBMITTED", created.value.id, null, { employeeTypeId: data.employeeTypeId }, now);
    await this.quietly(() => this.mailer.requestReceived({ to, school }));
    const recipients = await repo.hrRecipients();
    if (recipients.length) await this.quietly(() => this.mailer.newRequestForHr({ to: recipients, school, applicant: data.fullName, employeeType: created.value.employeeTypeName }));
    return ok({ received: true });
  }

  /** Email que falha não pode desfazer o que já foi gravado. */
  private async quietly(send: () => Promise<void>) {
    try {
      await send();
      return true;
    } catch {
      return false;
    }
  }

  // ================================================================ RH: consulta

  async list(repo: RegistrationRepository, input: { status?: string | null; q?: string | null; page?: number }) {
    const status = input.status && REQUEST_STATUSES.includes(input.status as RequestStatus) ? (input.status as RequestStatus) : null;
    const page = Math.max(1, input.page ?? 1);
    const q = input.q?.trim().slice(0, 80) || null;
    const r = await repo.list({ status, q, page, pageSize: PAGE_SIZE });
    const now = this.clock.now();
    return { items: r.items.map((x) => requestDto(x, now)), total: r.total, page, pageSize: PAGE_SIZE, counts: r.counts, statuses: REQUEST_STATUSES.map((s) => ({ value: s, label: REQUEST_STATUS_LABELS[s] })) };
  }

  async detail(repo: RegistrationRepository, settings: HrSettingsRepository, id: string) {
    const [r, history, latest] = await Promise.all([repo.find(id), repo.history(id), settings.latest()]);
    if (!r) return fail(hrError("REQUEST_NOT_FOUND", "Pedido não encontrado."));
    return ok({
      request: requestDto(r, this.clock.now()),
      history: history.map(historyDto),
      // tipos da versão em uso (o RH confirma ou corrige a função ao aprovar)
      employeeTypes: latest?.snapshot.employeeTypes ?? [],
      formPublished: !!latest,
      inviteValidDays: INVITE_VALID_DAYS,
    });
  }

  // ================================================================ RH: decisões

  private newInvite(employeeTypeId: string | null, now: Date): { invite: NewInvite; token: string } {
    const token = newInviteToken();
    return { token, invite: { id: this.ids.next(), tokenHash: hashInviteToken(token), employeeTypeId, expiresAt: inviteExpiry(now) } };
  }

  /** Envia o convite e marca o resultado (o RH vê "não enviado" e pode reenviar). */
  private async sendInvite(repo: RegistrationRepository, school: School, r: RequestRow, token: string, inviteId: string, expiresAt: Date) {
    try {
      await this.mailer.invite({ to: { email: r.email, name: r.fullName }, school, token, expiresAt, employeeType: r.invite?.employeeTypeName ?? null });
      await repo.markInviteSent(inviteId, this.clock.now());
      return true;
    } catch (e) {
      await repo.markInviteFailed(inviteId, (e instanceof Error ? e.message : "falha no envio").slice(0, 300));
      return false;
    }
  }

  /** Aprova: confirma (ou corrige) a função e envia o convite para o formulário. */
  async approve(repo: RegistrationRepository, settings: HrSettingsRepository, school: School, actor: HrActor, id: string, input: { employeeTypeId?: string | null }) {
    const latest = await settings.latest();
    if (!latest) return fail(hrError("FORM_NOT_PUBLISHED", "Publique o formulário de cadastro antes de aprovar pedidos."));
    const types = latest.snapshot.employeeTypes ?? [];
    const typeId = input.employeeTypeId ?? null;
    if (types.length && !types.some((t) => t.id === typeId)) return fail(hrError("INVALID_INPUT", "Escolha o tipo de funcionário."));
    if (!types.length && typeId) return fail(hrError("INVALID_INPUT", "Tipo de funcionário inválido."));

    const now = this.clock.now();
    const { invite, token } = this.newInvite(typeId, now);
    const r = await repo.approve({ id, actorId: actor.id, actorName: actor.name, reason: null, now, employeeTypeId: typeId, invite });
    if (!r.ok) return fail(decisionError(r));
    await repo.record("HR_REQUEST_APPROVED", id, actor.id, { employeeTypeId: typeId, inviteId: invite.id }, now);
    const emailSent = await this.sendInvite(repo, school, r.value, token, invite.id, invite.expiresAt);
    return ok({ request: requestDto((await repo.find(id))!, this.clock.now()), emailSent });
  }

  async reject(repo: RegistrationRepository, school: School, actor: HrActor, id: string, input: { reason: string; notify?: boolean }) {
    const reason = checkReason(input.reason, true);
    if (!reason.ok) return reason;
    const now = this.clock.now();
    const r = await repo.reject({ id, actorId: actor.id, actorName: actor.name, reason: reason.value, now });
    if (!r.ok) return fail(decisionError(r));
    await repo.record("HR_REQUEST_REJECTED", id, actor.id, { reason: reason.value }, now);
    // a justificação só segue no email se o RH quiser (pode ser interna)
    const emailSent = await this.quietly(() => this.mailer.rejected({ to: { email: r.value.email, name: r.value.fullName }, school, reason: input.notify ? reason.value : null }));
    return ok({ request: requestDto(r.value, now), emailSent });
  }

  /** Cancela um pedido pendente ou aprovado (o convite deixa de valer). */
  async cancel(repo: RegistrationRepository, actor: HrActor, id: string, input: { reason: string }) {
    const reason = checkReason(input.reason, true);
    if (!reason.ok) return reason;
    const now = this.clock.now();
    const r = await repo.cancel({ id, actorId: actor.id, actorName: actor.name, reason: reason.value, now });
    if (!r.ok) return fail(decisionError(r));
    await repo.record("HR_REQUEST_CANCELLED", id, actor.id, { reason: reason.value }, now);
    return ok({ request: requestDto(r.value, now) });
  }

  /** Novo convite (o anterior deixa de valer): para convites expirados ou emails que não chegaram. */
  async resendInvite(repo: RegistrationRepository, school: School, actor: HrActor, id: string) {
    const current = await repo.find(id);
    if (!current) return fail(hrError("REQUEST_NOT_FOUND", "Pedido não encontrado."));
    const now = this.clock.now();
    const { invite, token } = this.newInvite(current.invite?.employeeTypeId ?? current.employeeTypeId, now);
    const r = await repo.reissueInvite({ requestId: id, actorId: actor.id, invite, now });
    if (!r.ok) return fail(decisionError(r));
    await repo.record("HR_INVITE_REISSUED", id, actor.id, { inviteId: invite.id }, now);
    const emailSent = await this.sendInvite(repo, school, r.value, token, invite.id, invite.expiresAt);
    if (!emailSent) return fail(hrError("EMAIL_NOT_SENT", "O convite foi criado, mas o email não seguiu. Tente reenviar dentro de momentos."));
    return ok({ request: requestDto((await repo.find(id))!, this.clock.now()), emailSent });
  }
}
