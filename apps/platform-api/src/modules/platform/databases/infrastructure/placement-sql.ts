import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/platform-client";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import type { AllocationView, PlacementStore, SchoolDatabaseStatus } from "../application/ports";
import type { ServerActivityType } from "../domain/DatabaseServer";
import { databaseError, type DatabaseError } from "../domain/errors";
import { acceptsNewSchool, freeSlots, type PlacementCandidate, rankForAutoPlacement } from "../domain/placement";

type Db = PrismaClient | Prisma.TransactionClient;

type AllocationRow = Prisma.DatabaseAllocationGetPayload<{
  include: { school: { select: { id: true; name: true; status: true } }; server: { select: { id: true; name: true; kind: true } } };
}>;

const withRefs = {
  school: { select: { id: true, name: true, status: true } },
  server: { select: { id: true, name: true, kind: true } },
} as const;

export function allocationView(r: AllocationRow): AllocationView {
  return {
    id: r.id,
    status: r.status,
    school: r.school,
    server: r.server,
    reservedAt: r.reservedAt,
    expiresAt: r.expiresAt,
    assignedAt: r.assignedAt,
    releasedAt: r.releasedAt,
    releaseReason: r.releaseReason,
    expired: r.status === "RESERVED" && !!r.expiresAt && r.expiresAt <= new Date(),
  };
}

export async function staffNames(db: Db, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  const rows = unique.length ? await db.staffMember.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

async function logActivity(db: Db, serverId: string, type: ServerActivityType, staffId: string | null, details: Record<string, unknown>) {
  await db.databaseServerActivity.create({
    data: { id: randomUUID(), serverId, type, actorStaffId: staffId, details: details as Prisma.InputJsonValue, occurredAt: new Date() },
  });
}

/** Servidores + ocupação (reservas dentro do prazo + atribuídos). */
async function candidates(db: Db, ids?: string[]): Promise<PlacementCandidate[]> {
  const servers = await db.databaseServer.findMany({
    where: ids ? { id: { in: ids } } : undefined,
    select: { id: true, name: true, kind: true, status: true, health: true, region: true, capacity: true, lastLatencyMs: true },
    orderBy: { createdAt: "asc" },
  });
  if (!servers.length) return [];
  const usage = await db.$queryRaw<{ server_id: string; assigned: number; reserved: number }[]>`
    SELECT server_id,
           count(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned,
           count(*) FILTER (WHERE status = 'RESERVED' AND expires_at > now())::int AS reserved
    FROM database_allocations GROUP BY server_id`;
  const byId = new Map(usage.map((u) => [u.server_id, u]));
  return servers.map((s) => ({ ...s, assigned: byId.get(s.id)?.assigned ?? 0, reserved: byId.get(s.id)?.reserved ?? 0 }));
}

/** Bloqueia a linha do servidor (até ao fim da transação) e devolve a ocupação atual. */
async function lockCandidate(tx: Prisma.TransactionClient, serverId: string) {
  await tx.$queryRaw`SELECT id FROM database_servers WHERE id = ${serverId}::uuid FOR UPDATE`;
  return (await candidates(tx, [serverId]))[0] ?? null;
}

class Abort extends Error {
  constructor(readonly error: DatabaseError) {
    super(error.message);
  }
}

/**
 * Chamado DENTRO da transação que ativa o colégio (pagamento confirmado):
 *   reserva válida → atribuída; reserva expirada → atribuída se ainda houver espaço;
 *   sem reserva → escolha automática. Devolve o servidor (ou null: fica à espera).
 */
export async function assignOnActivation(tx: Prisma.TransactionClient, schoolId: string): Promise<string | null> {
  const job = await tx.tenantProvisioningJob.findUnique({ where: { schoolId }, select: { status: true, serverId: true, provisionedAt: true } });
  if (job && (job.status === "DONE" || job.provisionedAt)) return job.serverId; // renovação: a BD já existe

  const assigned = await tx.databaseAllocation.findFirst({ where: { schoolId, status: "ASSIGNED" }, select: { serverId: true } });
  if (assigned) return assigned.serverId;

  const now = new Date();
  const reservation = await tx.databaseAllocation.findFirst({ where: { schoolId, status: "RESERVED" }, orderBy: { reservedAt: "desc" } });
  if (reservation) {
    const server = await lockCandidate(tx, reservation.serverId);
    const valid = !!reservation.expiresAt && reservation.expiresAt > now;
    if (server && (valid || (server.status === "ACTIVE" && freeSlots(server) > 0))) {
      await tx.databaseAllocation.update({ where: { id: reservation.id }, data: { status: "ASSIGNED", assignedAt: now } });
      await logActivity(tx, server.id, "DATABASE_ASSIGNED", null, { schoolId, fromReservation: true });
      return server.id;
    }
    await tx.databaseAllocation.update({
      where: { id: reservation.id },
      data: { status: "EXPIRED", releasedAt: now, releaseReason: "Reserva expirada sem espaço no servidor" },
    });
  }

  for (const candidate of rankForAutoPlacement(await candidates(tx))) {
    const server = await lockCandidate(tx, candidate.id);
    if (!server || !acceptsNewSchool(server).ok) continue;
    await tx.databaseAllocation.create({
      data: { id: randomUUID(), serverId: server.id, schoolId, status: "ASSIGNED", reservedAt: now, assignedAt: now },
    });
    await logActivity(tx, server.id, "DATABASE_ASSIGNED", null, { schoolId, automatic: true });
    return server.id;
  }
  return null;
}

export class PrismaPlacementStore implements PlacementStore {
  constructor(private readonly prisma: PrismaClient) {}

  candidates() {
    return candidates(this.prisma);
  }

  async schoolStatus(schoolId: string) {
    return (await this.prisma.school.findUnique({ where: { id: schoolId }, select: { status: true } }))?.status ?? null;
  }

  async status(schoolId: string): Promise<SchoolDatabaseStatus> {
    const [job, allocation] = await Promise.all([
      this.prisma.tenantProvisioningJob.findUnique({
        where: { schoolId },
        select: { status: true, attempts: true, lastError: true, provisionedAt: true, server: { select: { id: true, name: true, kind: true } } },
      }),
      this.prisma.databaseAllocation.findFirst({
        where: { schoolId, status: { in: ["RESERVED", "ASSIGNED"] } },
        include: withRefs,
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const view = allocation ? allocationView(allocation) : null;
    const server = job?.server ?? view?.server ?? null;
    const provisioning = job
      ? { status: job.status, attempts: job.attempts, lastError: job.lastError, provisioned: job.provisionedAt !== null }
      : null;

    let state: SchoolDatabaseStatus["state"] = "NONE";
    if (job) {
      if (job.status === "DONE") state = "READY";
      // a BD já existe: voltar à fila só aplica migrações (nunca muda de servidor)
      else if (job.provisionedAt) state = job.status === "FAILED" ? "FAILED" : "UPDATING";
      else if (!job.server) state = "WAITING_SERVER";
      else if (job.status === "FAILED") state = "FAILED";
      else state = "PROVISIONING";
    } else if (view?.status === "RESERVED") {
      state = view.expired ? "RESERVATION_EXPIRED" : "RESERVED";
    }
    return { state, server, allocation: view, provisioning };
  }

  async reserve(input: { schoolId: string; serverIds: string[]; staffId: string; expiresAt: Date }): Promise<Result<AllocationView, DatabaseError>> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (await tx.databaseAllocation.count({ where: { schoolId: input.schoolId, status: "ASSIGNED" } })) {
          throw new Abort(databaseError("INVALID_STATE", "Este colégio já tem a base de dados atribuída."));
        }
        const now = new Date();
        const previous = await tx.databaseAllocation.findMany({ where: { schoolId: input.schoolId, status: "RESERVED" } });
        await tx.databaseAllocation.updateMany({
          where: { schoolId: input.schoolId, status: "RESERVED" },
          data: { status: "RELEASED", releasedAt: now, releaseReason: "Substituída por nova reserva", actorStaffId: input.staffId },
        });

        for (const serverId of input.serverIds) {
          const server = await lockCandidate(tx, serverId);
          if (!server || !acceptsNewSchool(server).ok) continue;
          const created = await tx.databaseAllocation.create({
            data: {
              id: randomUUID(),
              serverId,
              schoolId: input.schoolId,
              status: "RESERVED",
              reservedAt: now,
              expiresAt: input.expiresAt,
              actorStaffId: input.staffId,
            },
            include: withRefs,
          });
          for (const p of previous.filter((p) => p.serverId !== serverId)) {
            await logActivity(tx, p.serverId, "RESERVATION_RELEASED", input.staffId, { schoolId: input.schoolId, reason: "Substituída por nova reserva" });
          }
          await logActivity(tx, serverId, "DATABASE_RESERVED", input.staffId, {
            schoolId: input.schoolId,
            school: created.school.name,
            expiresAt: input.expiresAt.toISOString(),
          });
          return created;
        }
        throw new Abort(databaseError("NO_CAPACITY", "Nenhum servidor escolhido tem espaço livre. Escolha outro ou registe um novo servidor."));
      });
      return ok(allocationView(row));
    } catch (error) {
      if (error instanceof Abort) return fail(error.error);
      throw error;
    }
  }

  async release(input: { schoolId?: string; allocationId?: string; reason: string; staffId: string | null }) {
    const rows = await this.prisma.databaseAllocation.findMany({
      where: { status: "RESERVED", schoolId: input.schoolId, id: input.allocationId },
      include: withRefs,
    });
    if (!rows.length) return 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.databaseAllocation.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: "RELEASED", releasedAt: new Date(), releaseReason: input.reason, actorStaffId: input.staffId },
      });
      for (const r of rows) {
        await logActivity(tx, r.serverId, "RESERVATION_RELEASED", input.staffId, { schoolId: r.schoolId, school: r.school.name, reason: input.reason });
      }
    });
    return rows.length;
  }

  async assignWaiting(input: { schoolId: string; serverId: string; staffId: string }): Promise<Result<AllocationView, DatabaseError>> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const job = await tx.tenantProvisioningJob.findUnique({ where: { schoolId: input.schoolId } });
        if (!job || job.status === "DONE" || (job.serverId && job.status !== "FAILED")) {
          throw new Abort(databaseError("INVALID_STATE", "Este colégio não está à espera de servidor."));
        }
        // a BD do colégio já foi criada (tem dados): mudar de servidor criaria uma BD vazia
        if (job.provisionedAt) {
          throw new Abort(databaseError("SERVER_IN_USE", "A base de dados deste colégio já existe — não é possível mudá-lo de servidor por aqui."));
        }
        const server = await lockCandidate(tx, input.serverId);
        if (!server) throw new Abort(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
        const accepts = acceptsNewSchool(server);
        if (!accepts.ok) throw new Abort(databaseError("NO_CAPACITY", accepts.reason));

        const now = new Date();
        // uma tentativa falhada noutro servidor deixa de contar para a sua ocupação
        const old = await tx.databaseAllocation.findMany({ where: { schoolId: input.schoolId, status: { in: ["RESERVED", "ASSIGNED"] } } });
        await tx.databaseAllocation.updateMany({
          where: { id: { in: old.map((o) => o.id) } },
          data: { status: "RELEASED", releasedAt: now, releaseReason: "Movido para outro servidor", actorStaffId: input.staffId },
        });
        const created = await tx.databaseAllocation.create({
          data: {
            id: randomUUID(),
            serverId: input.serverId,
            schoolId: input.schoolId,
            status: "ASSIGNED",
            reservedAt: now,
            assignedAt: now,
            actorStaffId: input.staffId,
          },
          include: withRefs,
        });
        await tx.tenantProvisioningJob.update({
          where: { id: job.id },
          data: { serverId: input.serverId, status: "PENDING", attempts: 0, lastError: null },
        });
        await logActivity(tx, input.serverId, "DATABASE_ASSIGNED", input.staffId, { schoolId: input.schoolId, school: created.school.name });
        return created;
      });
      return ok(allocationView(row));
    } catch (error) {
      if (error instanceof Abort) return fail(error.error);
      throw error;
    }
  }
}
