import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Decision, DecisionOutcome, NewInvite, RegistrationRepository, RequestRow } from "../application/registration-ports";
import { REQUEST_STATUSES, type RequestInput, type RequestStatus } from "../domain/registration";

type Tx = Prisma.TransactionClient;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const INCLUDE = {
  employeeType: { select: { name: true } },
  invites: { where: { revokedAt: null }, include: { employeeType: { select: { name: true } } }, take: 1 },
} as const satisfies Prisma.EmployeeRegistrationRequestInclude;

type Row = Prisma.EmployeeRegistrationRequestGetPayload<{ include: typeof INCLUDE }>;

export class PrismaRegistrationRepository implements RegistrationRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Nomes de quem decidiu (a conta pode mudar; o histórico guarda o nome do momento). */
  private async toRows(rows: Row[]): Promise<RequestRow[]> {
    const ids = [...new Set(rows.map((r) => r.decidedById).filter((x): x is string => !!x))];
    const users = ids.length ? await this.db.schoolUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => {
      const i = r.invites[0];
      return {
        id: r.id,
        fullName: r.fullName,
        email: r.email,
        phone: r.phone,
        employeeTypeId: r.employeeTypeId,
        employeeTypeName: r.employeeType?.name ?? null,
        status: r.status as RequestStatus,
        termsAcceptedAt: r.termsAcceptedAt,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        decidedBy: r.decidedById ? (names.get(r.decidedById) ?? null) : null,
        decisionReason: r.decisionReason,
        invite: i
          ? {
              id: i.id,
              employeeTypeId: i.employeeTypeId,
              employeeTypeName: i.employeeType?.name ?? null,
              expiresAt: i.expiresAt,
              sentAt: i.sentAt,
              sendError: i.sendError,
              revokedAt: i.revokedAt,
              lastUsedAt: i.lastUsedAt,
              createdAt: i.createdAt,
            }
          : null,
      };
    });
  }

  async createRequest(input: Omit<RequestInput, "password"> & { id: string; passwordHash: string; ip: string | null; userAgent: string | null; now: Date }) {
    try {
      const row = await this.db.$transaction(async (tx) => {
        const r = await tx.employeeRegistrationRequest.create({
          data: {
            id: input.id,
            fullName: input.fullName,
            email: input.email,
            phone: input.phone,
            passwordHash: input.passwordHash,
            employeeTypeId: input.employeeTypeId,
            status: "PENDING",
            termsAcceptedAt: input.now,
            ip: input.ip,
            userAgent: input.userAgent,
            createdAt: input.now,
            updatedAt: input.now,
          },
          include: INCLUDE,
        });
        await this.addHistory(tx, { subjectId: r.id, from: null, to: "PENDING", actorId: null, actorName: null, reason: null, now: input.now });
        return r;
      });
      return { ok: true as const, value: (await this.toRows([row]))[0] };
    } catch (e) {
      // o índice único parcial: já há um pedido pendente ou aprovado com este email
      if (isUnique(e)) return { ok: false as const, reason: "duplicate" as const };
      throw e;
    }
  }

  async list(input: { status: RequestStatus | null; q: string | null; page: number; pageSize: number }) {
    const where: Prisma.EmployeeRegistrationRequestWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.q ? { OR: [{ fullName: { contains: input.q, mode: "insensitive" } }, { email: { contains: input.q.toLowerCase() } }, { phone: { contains: input.q } }] } : {}),
    };
    const [rows, total, grouped] = await Promise.all([
      this.db.employeeRegistrationRequest.findMany({ where, include: INCLUDE, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
      this.db.employeeRegistrationRequest.count({ where }),
      this.db.employeeRegistrationRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<RequestStatus, number>;
    return { items: await this.toRows(rows), total, counts };
  }

  async find(id: string) {
    const row = await this.db.employeeRegistrationRequest.findUnique({ where: { id }, include: INCLUDE });
    return row ? (await this.toRows([row]))[0] : null;
  }

  async history(id: string) {
    const rows = await this.db.employeeApprovalHistory.findMany({ where: { subjectType: "REQUEST", subjectId: id }, orderBy: { createdAt: "asc" } });
    return rows.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, actorName: h.actorName, reason: h.reason, createdAt: h.createdAt }));
  }

  private async addHistory(tx: Tx, h:{ subjectId: string; from: string | null; to: string; actorId: string | null; actorName: string | null; reason: string | null; now: Date }) {
    await tx.employeeApprovalHistory.create({
      data: { id: randomUUID(), subjectType: "REQUEST", subjectId: h.subjectId, fromStatus: h.from, toStatus: h.to, actorId: h.actorId, actorName: h.actorName, reason: h.reason, createdAt: h.now },
    });
  }

  /** Bloqueia o pedido e confirma o estado — duas decisões ao mesmo tempo não passam as duas. */
  private async transition(d: Decision, from: RequestStatus[], to: RequestStatus, extra: (tx: Tx) => Promise<void> = async () => {}): Promise<DecisionOutcome> {
    const done = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "employee_registration_requests" WHERE "id" = ${d.id}::uuid FOR UPDATE`;
      if (!rows[0]) return { ok: false, reason: "not_found" } as const;
      const status = rows[0].status as RequestStatus;
      if (!from.includes(status)) return { ok: false, reason: "state", status } as const;
      await tx.employeeRegistrationRequest.update({ where: { id: d.id }, data: { status: to, decidedById: d.actorId, decidedAt: d.now, decisionReason: d.reason, updatedAt: d.now } });
      await extra(tx);
      await this.addHistory(tx, { subjectId: d.id, from: status, to, actorId: d.actorId, actorName: d.actorName, reason: d.reason, now: d.now });
      return { ok: true } as const;
    });
    if (!done.ok) return done;
    return { ok: true, value: (await this.find(d.id))! };
  }

  private createInvite(tx: Tx, requestId: string, invite: NewInvite, actorId: string | null, now: Date) {
    return tx.employeeRegistrationInvite.create({
      data: { id: invite.id, requestId, tokenHash: invite.tokenHash, employeeTypeId: invite.employeeTypeId, expiresAt: invite.expiresAt, createdById: actorId, createdAt: now },
    });
  }

  approve(d: Decision & { employeeTypeId: string | null; invite: NewInvite }) {
    return this.transition(d, ["PENDING"], "APPROVED", async (tx) => {
      // a função confirmada pelo RH fica no pedido e no convite
      await tx.employeeRegistrationRequest.update({ where: { id: d.id }, data: { employeeTypeId: d.employeeTypeId } });
      await this.createInvite(tx, d.id, d.invite, d.actorId, d.now);
    });
  }

  reject(d: Decision) {
    return this.transition(d, ["PENDING"], "REJECTED");
  }

  async employeeOf(requestId: string) {
    return this.db.employee.findUnique({ where: { requestId }, select: { id: true, status: true } });
  }

  cancel(d: Decision) {
    return this.transition(d, ["PENDING", "APPROVED"], "CANCELLED", async (tx) => {
      await tx.employeeRegistrationInvite.updateMany({ where: { requestId: d.id, revokedAt: null }, data: { revokedAt: d.now } });
      // o rascunho começado com o convite fecha-se (com o mesmo motivo)
      const draft = await tx.employee.findFirst({ where: { requestId: d.id, status: { in: ["DRAFT", "CORRECTION_REQUIRED"] } }, select: { id: true, status: true } });
      if (draft) {
        await tx.employee.update({ where: { id: draft.id }, data: { status: "REJECTED", updatedAt: d.now, revision: { increment: 1 } } });
        await tx.employeeApprovalHistory.create({
          data: { id: randomUUID(), subjectType: "EMPLOYEE", subjectId: draft.id, fromStatus: draft.status, toStatus: "REJECTED", actorId: d.actorId, actorName: d.actorName, reason: `Pedido cancelado: ${d.reason ?? ""}`.slice(0, 500), createdAt: d.now },
        });
      }
    });
  }

  async reissueInvite(input: { requestId: string; actorId: string | null; invite: NewInvite; now: Date }): Promise<DecisionOutcome> {
    const done = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "employee_registration_requests" WHERE "id" = ${input.requestId}::uuid FOR UPDATE`;
      if (!rows[0]) return { ok: false, reason: "not_found" } as const;
      const status = rows[0].status as RequestStatus;
      if (status !== "APPROVED") return { ok: false, reason: "state", status } as const;
      await tx.employeeRegistrationInvite.updateMany({ where: { requestId: input.requestId, revokedAt: null }, data: { revokedAt: input.now } });
      await this.createInvite(tx, input.requestId, input.invite, input.actorId, input.now);
      return { ok: true } as const;
    });
    if (!done.ok) return done;
    return { ok: true, value: (await this.find(input.requestId))! };
  }

  async markInviteSent(inviteId: string, now: Date) {
    await this.db.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { sentAt: now, sendError: null } });
  }

  async markInviteFailed(inviteId: string, error: string) {
    await this.db.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { sendError: error } });
  }

  async hrRecipients() {
    const users = await this.db.schoolUser.findMany({
      where: { status: "ACTIVE", email: { not: null }, OR: [{ isOwner: true }, { permissions: { some: { permission: "hr.registration_requests.view" } } }] },
      select: { email: true, fullName: true },
    });
    return users.map((u) => ({ email: u.email!, name: u.fullName }));
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
