import { randomUUID } from "node:crypto";
import type { DatabaseServer as ServerRow, Prisma, PrismaClient } from ".prisma/platform-client";
import type { SslMode } from "../../../../../../../libs/kernel/src/domain/postgres-url";
import type {
  AllocationView,
  CheckView,
  DatabaseServerQueries,
  DatabaseServerRepository,
  ServerActivityView,
} from "../application/ports";
import { DatabaseServer, type ServerActivityType } from "../domain/DatabaseServer";
import { allocationView, staffNames } from "./placement-sql";

/** Colunas que a plataforma pode ler (nunca a tabela de segredos). */
function toDomain(row: ServerRow): DatabaseServer {
  return DatabaseServer.restore({
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    region: row.region,
    notes: row.notes,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    sslMode: row.sslMode as SslMode,
    endpoint: row.endpoint,
    capacity: row.capacity,
    healthState: {
      health: row.health,
      lastCheckedAt: row.lastCheckedAt,
      lastLatencyMs: row.lastLatencyMs,
      serverVersion: row.serverVersion,
      tlsActive: row.tlsActive,
      lastError: row.lastError,
      consecutiveFailures: row.consecutiveFailures,
    },
    credentialsUpdatedAt: row.credentialsUpdatedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
  });
}

type CheckRow = Prisma.DatabaseServerCheckGetPayload<object>;

export class PrismaDatabaseServerRepository implements DatabaseServerRepository, DatabaseServerQueries {
  constructor(private readonly prisma: PrismaClient) {}

  // ================================================================ agregado

  async findById(id: string) {
    const row = await this.prisma.databaseServer.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async endpointExists(endpoint: string, exceptId?: string) {
    return (await this.prisma.databaseServer.count({ where: { endpoint, id: exceptId ? { not: exceptId } : undefined } })) > 0;
  }

  async save(server: DatabaseServer, sealedUrl?: string) {
    const s = server.snapshot;
    const data = {
      name: s.name,
      kind: s.kind,
      status: s.status,
      region: s.region,
      notes: s.notes,
      host: s.host,
      port: s.port,
      database: s.database,
      username: s.username,
      sslMode: s.sslMode,
      endpoint: s.endpoint,
      capacity: s.capacity,
      credentialsUpdatedAt: s.credentialsUpdatedAt,
    };
    // A saúde é escrita pelo provisioner. A plataforma só a repõe quando muda o URL.
    const health = {
      health: s.healthState.health,
      lastCheckedAt: s.healthState.lastCheckedAt,
      lastLatencyMs: s.healthState.lastLatencyMs,
      serverVersion: s.healthState.serverVersion,
      tlsActive: s.healthState.tlsActive,
      lastError: s.healthState.lastError,
      consecutiveFailures: s.healthState.consecutiveFailures,
    };
    const events = server.pullEvents();

    await this.prisma.$transaction(async (tx) => {
      await tx.databaseServer.upsert({
        where: { id: s.id },
        create: { id: s.id, createdById: s.createdById, createdAt: s.createdAt, ...data, ...health },
        update: sealedUrl ? { ...data, ...health } : data,
      });
      if (sealedUrl) {
        // Sem RETURNING nem SELECT: a plataforma não tem permissão para LER esta tabela.
        const updated = await tx.$executeRaw`
          UPDATE database_server_secrets SET url_ciphertext = ${sealedUrl}, updated_at = now() WHERE server_id = ${s.id}::uuid`;
        if (updated === 0) {
          await tx.$executeRaw`
            INSERT INTO database_server_secrets (server_id, url_ciphertext, updated_at) VALUES (${s.id}::uuid, ${sealedUrl}, now())`;
        }
      }
      if (events.length) {
        await tx.databaseServerActivity.createMany({
          data: events.map((e) => ({
            id: randomUUID(),
            serverId: s.id,
            type: e.type,
            actorStaffId: e.actorStaffId,
            details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
            occurredAt: e.occurredAt,
          })),
        });
      }
    });
  }

  async remove(id: string) {
    await this.prisma.$transaction([
      this.prisma.$executeRaw`DELETE FROM database_server_secrets WHERE server_id = ${id}::uuid`,
      this.prisma.databaseAllocation.deleteMany({ where: { serverId: id, status: { in: ["RELEASED", "EXPIRED"] } } }),
      this.prisma.databaseServer.delete({ where: { id } }),
    ]);
  }

  async usage(id: string) {
    const [assigned, reserved, everAssigned] = await Promise.all([
      this.prisma.databaseAllocation.count({ where: { serverId: id, status: "ASSIGNED" } }),
      this.prisma.databaseAllocation.count({ where: { serverId: id, status: "RESERVED", expiresAt: { gt: new Date() } } }),
      this.prisma.tenantProvisioningJob.count({ where: { serverId: id } }),
    ]);
    return { assigned, reserved, everAssigned: everAssigned + assigned };
  }

  async requeueProvisioning(serverId: string) {
    const { count } = await this.prisma.tenantProvisioningJob.updateMany({
      where: { serverId },
      data: { status: "PENDING", attempts: 0, lastError: null },
    });
    return count;
  }

  async requestCheck(serverId: string, kind: "REGISTRATION" | "MANUAL", staffId: string) {
    // um teste pendente de cada vez por servidor (evita encher a fila)
    const pending = await this.prisma.databaseServerCheck.findFirst({
      where: { serverId, status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    });
    if (pending) return pending.id;
    const id = randomUUID();
    await this.prisma.databaseServerCheck.create({ data: { id, serverId, kind, requestedById: staffId } });
    return id;
  }

  // ================================================================ consultas

  async list() {
    const rows = await this.prisma.databaseServer.findMany({ orderBy: [{ status: "asc" }, { createdAt: "asc" }] });
    if (!rows.length) return [];
    const [usage, latency] = await Promise.all([
      this.prisma.$queryRaw<{ server_id: string; assigned: number; reserved: number }[]>`
        SELECT server_id,
               count(*) FILTER (WHERE status = 'ASSIGNED')::int AS assigned,
               count(*) FILTER (WHERE status = 'RESERVED' AND expires_at > now())::int AS reserved
        FROM database_allocations GROUP BY server_id`,
      this.prisma.$queryRaw<{ server_id: string; latency_ms: number | null; ok: boolean | null }[]>`
        SELECT server_id, latency_ms, ok FROM (
          SELECT server_id, latency_ms, ok, created_at,
                 row_number() OVER (PARTITION BY server_id ORDER BY created_at DESC) AS rn
          FROM database_server_checks WHERE status = 'DONE'
        ) t WHERE rn <= 24 ORDER BY created_at ASC`,
    ]);
    const usageById = new Map(usage.map((u) => [u.server_id, u]));
    return rows.map((row) => ({
      server: toDomain(row),
      usage: { assigned: usageById.get(row.id)?.assigned ?? 0, reserved: usageById.get(row.id)?.reserved ?? 0 },
      recentLatency: latency.filter((l) => l.server_id === row.id).map((l) => (l.ok ? l.latency_ms : null)),
    }));
  }

  private async checkViews(rows: CheckRow[]): Promise<CheckView[]> {
    const names = await staffNames(this.prisma, rows.map((r) => r.requestedById));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      ok: r.ok,
      connectMs: r.connectMs,
      latencyMs: r.latencyMs,
      serverVersion: r.serverVersion,
      tls: r.tls,
      details: (r.details as Record<string, unknown> | null) ?? null,
      error: r.error,
      requestedBy: r.requestedById ? (names.get(r.requestedById) ?? null) : null,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    }));
  }

  async checks(serverId: string, limit: number) {
    const rows = await this.prisma.databaseServerCheck.findMany({ where: { serverId }, orderBy: { createdAt: "desc" }, take: limit });
    return this.checkViews(rows);
  }

  async check(serverId: string, checkId: string) {
    const row = await this.prisma.databaseServerCheck.findFirst({ where: { id: checkId, serverId } });
    return row ? (await this.checkViews([row]))[0]! : null;
  }

  async allocations(serverId: string): Promise<AllocationView[]> {
    const rows = await this.prisma.databaseAllocation.findMany({
      where: { serverId },
      include: { school: { select: { id: true, name: true, status: true } }, server: { select: { id: true, name: true, kind: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map(allocationView);
  }

  async activity(serverId: string): Promise<ServerActivityView[]> {
    const rows = await this.prisma.databaseServerActivity.findMany({ where: { serverId }, orderBy: { occurredAt: "desc" }, take: 50 });
    const names = await staffNames(this.prisma, rows.map((r) => r.actorStaffId));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as ServerActivityType,
      actor: r.actorStaffId ? (names.get(r.actorStaffId) ?? null) : null,
      details: (r.details as Record<string, unknown> | null) ?? null,
      occurredAt: r.occurredAt,
    }));
  }
}
