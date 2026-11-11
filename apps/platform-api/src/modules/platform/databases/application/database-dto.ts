import type { DatabaseServer, ServerHealth, ServerKind } from "../domain/DatabaseServer";
import { acceptsNewSchool, freeSlots, type PlacementCandidate } from "../domain/placement";
import type { AllocationView, BackupView, CheckView, RestoreView, SchoolDatabaseStatus, ServerActivityView } from "./ports";

export const KIND_LABELS: Record<ServerKind, string> = {
  SHARED_SERVER: "Servidor partilhado",
  DEDICATED_DATABASE: "Base de dados dedicada",
};

export const HEALTH_LABELS: Record<ServerHealth, string> = {
  UNKNOWN: "Por testar",
  HEALTHY: "Saudável",
  DEGRADED: "Lento",
  UNREACHABLE: "Sem ligação",
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toServerSummary(
  server: DatabaseServer,
  usage: { assigned: number; reserved: number; usedBytes: number | null },
  recentLatency: (number | null)[] = [],
) {
  const s = server.snapshot;
  const h = s.healthState;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    kindLabel: KIND_LABELS[s.kind],
    status: s.status,
    region: s.region,
    notes: s.notes,
    // dados não secretos do URL (a senha nunca sai daqui)
    host: s.host,
    port: s.port,
    database: s.database,
    username: s.username,
    sslMode: s.sslMode,
    capacity: s.capacity,
    assigned: usage.assigned,
    reserved: usage.reserved,
    free: freeSlots({ capacity: s.capacity, ...usage }),
    /** soma dos dados das BDs dos colégios neste servidor (medida de hora a hora) */
    usedBytes: usage.usedBytes,
    health: h.health,
    healthLabel: HEALTH_LABELS[h.health],
    lastCheckedAt: iso(h.lastCheckedAt),
    lastLatencyMs: h.lastLatencyMs,
    serverVersion: h.serverVersion,
    tlsActive: h.tlsActive,
    lastError: h.lastError,
    consecutiveFailures: h.consecutiveFailures,
    recentLatency,
    credentialsUpdatedAt: s.credentialsUpdatedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  };
}

export function toCheckDto(c: CheckView) {
  return { ...c, createdAt: c.createdAt.toISOString(), completedAt: iso(c.completedAt) };
}

export function toAllocationDto(a: AllocationView) {
  return {
    ...a,
    reservedAt: a.reservedAt.toISOString(),
    expiresAt: iso(a.expiresAt),
    assignedAt: iso(a.assignedAt),
    releasedAt: iso(a.releasedAt),
  };
}

export function toActivityDto(a: ServerActivityView) {
  return { ...a, occurredAt: a.occurredAt.toISOString() };
}

export function toCandidateDto(c: PlacementCandidate) {
  const accepts = acceptsNewSchool(c);
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    kindLabel: KIND_LABELS[c.kind],
    health: c.health,
    healthLabel: HEALTH_LABELS[c.health],
    region: c.region,
    capacity: c.capacity,
    assigned: c.assigned,
    reserved: c.reserved,
    free: freeSlots(c),
    lastLatencyMs: c.lastLatencyMs,
    available: accepts.ok,
    unavailableReason: accepts.ok ? null : accepts.reason,
  };
}

export const BACKUP_STATUS_LABELS: Record<BackupView["status"], string> = {
  PENDING: "Na fila",
  RUNNING: "A copiar",
  DONE: "Concluída",
  FAILED: "Falhou",
  DELETED: "Apagada (prazo)",
};

const TRIGGER_LABELS: Record<BackupView["trigger"], string> = { MANUAL: "Manual", AUTOMATIC: "Automática", PRE_RESTORE: "Antes de restaurar" };

export function toBackupDto(b: BackupView) {
  return {
    ...b,
    statusLabel: BACKUP_STATUS_LABELS[b.status],
    triggerLabel: TRIGGER_LABELS[b.trigger],
    createdAt: b.createdAt.toISOString(),
    completedAt: iso(b.completedAt),
  };
}

const RESTORE_STATUS_LABELS: Record<RestoreView["status"], string> = {
  PENDING: "Na fila",
  RUNNING: "A restaurar",
  DONE: "Concluído",
  FAILED: "Falhou",
};

export function toRestoreDto(r: RestoreView) {
  return {
    ...r,
    statusLabel: r.status === "FAILED" && r.rolledBack ? "Falhou · estado anterior reposto" : RESTORE_STATUS_LABELS[r.status],
    backupCreatedAt: r.backupCreatedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    completedAt: iso(r.completedAt),
  };
}

export const SCHOOL_DB_LABELS: Record<SchoolDatabaseStatus["state"], string> = {
  NONE: "Sem servidor reservado",
  RESERVED: "Servidor reservado",
  RESERVATION_EXPIRED: "Reserva expirada",
  WAITING_SERVER: "À espera de servidor",
  PROVISIONING: "A criar a base de dados",
  UPDATING: "A atualizar a base de dados",
  READY: "Base de dados pronta",
  FAILED: "Falha ao criar a base de dados",
};

export function toSchoolDatabaseDto(s: SchoolDatabaseStatus) {
  return {
    state: s.state,
    label: SCHOOL_DB_LABELS[s.state],
    server: s.server ? { ...s.server, kindLabel: KIND_LABELS[s.server.kind] } : null,
    allocation: s.allocation ? toAllocationDto(s.allocation) : null,
    provisioning: s.provisioning,
    storage: s.storage
      ? {
          databaseBytes: s.storage.databaseBytes,
          measuredAt: iso(s.storage.measuredAt),
          lastBackup: s.storage.lastBackup ? toBackupDto(s.storage.lastBackup) : null,
        }
      : null,
  };
}

export type SchoolDatabaseDto = ReturnType<typeof toSchoolDatabaseDto>;
