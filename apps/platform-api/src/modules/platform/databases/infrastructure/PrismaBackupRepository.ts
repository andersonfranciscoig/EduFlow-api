import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/platform-client";
import type { BackupRepository, BackupView } from "../application/ports";
import { staffNames } from "./placement-sql";

type Db = PrismaClient | Prisma.TransactionClient;
type BackupRow = Prisma.DatabaseBackupGetPayload<{ include: { school: { select: { id: true; name: true } } } }>;

export const bytes = (v: bigint | null | undefined) => (v == null ? null : Number(v));

export async function backupViews(db: Db, rows: BackupRow[]): Promise<BackupView[]> {
  const names = await staffNames(db, rows.map((r) => r.requestedById));
  return rows.map((r) => ({
    id: r.id,
    school: r.school,
    trigger: r.trigger,
    status: r.status,
    sizeBytes: bytes(r.sizeBytes),
    databaseBytes: bytes(r.databaseBytes),
    error: r.error,
    requestedBy: r.requestedById ? (names.get(r.requestedById) ?? null) : null,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  }));
}

/**
 * Tamanho das BDs dos colégios. A plataforma só pode ler estas colunas de
 * tenant_databases (as credenciais ficam de fora) — por isso SQL explícito.
 */
export async function databaseSizes(db: Db, schoolIds: string[]) {
  if (!schoolIds.length) return new Map<string, { bytes: number | null; measuredAt: Date | null }>();
  const rows = await db.$queryRaw<{ school_id: string; size_bytes: bigint | null; size_measured_at: Date | null }[]>`
    SELECT school_id::text, size_bytes, size_measured_at FROM tenant_databases WHERE school_id = ANY(${schoolIds}::uuid[])`;
  return new Map(rows.map((r) => [r.school_id, { bytes: bytes(r.size_bytes), measuredAt: r.size_measured_at }]));
}

const include = { school: { select: { id: true, name: true } } } as const;

export class PrismaBackupRepository implements BackupRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async schoolsOnServer(serverId: string) {
    const rows = await this.prisma.$queryRaw<{ school_id: string }[]>`
      SELECT a.school_id::text FROM database_allocations a
      JOIN tenant_databases td ON td.school_id = a.school_id
      WHERE a.server_id = ${serverId}::uuid AND a.status = 'ASSIGNED'`;
    return rows.map((r) => r.school_id);
  }

  async hasDatabase(schoolId: string) {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_databases WHERE school_id = ${schoolId}::uuid`;
    return (rows[0]?.n ?? 0) > 0;
  }

  async request(schoolIds: string[], staffId: string) {
    if (!schoolIds.length) return 0;
    const busy = await this.prisma.databaseBackup.findMany({
      where: { schoolId: { in: schoolIds }, status: { in: ["PENDING", "RUNNING"] } },
      select: { schoolId: true },
    });
    const skip = new Set(busy.map((b) => b.schoolId));
    const todo = schoolIds.filter((id) => !skip.has(id));
    if (!todo.length) return 0;
    const { count } = await this.prisma.databaseBackup.createMany({
      data: todo.map((schoolId) => ({ id: randomUUID(), schoolId, trigger: "MANUAL", status: "PENDING", requestedById: staffId })),
    });
    return count;
  }

  async forServer(serverId: string, limit: number) {
    // inclui as cópias ainda na fila (server_id só é preenchido pelo provisioner)
    const schoolIds = await this.schoolsOnServer(serverId);
    const rows = await this.prisma.databaseBackup.findMany({
      where: { OR: [{ serverId }, { schoolId: { in: schoolIds } }] },
      include,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return backupViews(this.prisma, rows);
  }

  async forSchool(schoolId: string, limit: number) {
    const rows = await this.prisma.databaseBackup.findMany({ where: { schoolId }, include, orderBy: { createdAt: "desc" }, take: limit });
    return backupViews(this.prisma, rows);
  }
}
