import type { Result } from "../../../../../../../libs/kernel/src/domain/Result";
import type { DatabaseServer, ServerEvent } from "../domain/DatabaseServer";
import type { DatabaseError } from "../domain/errors";
import type { PlacementCandidate } from "../domain/placement";

/** Sela (cifra) o URL com a chave PÚBLICA do provisioner. A plataforma não consegue abrir. */
export interface CredentialSealer {
  seal(url: string): string;
}

export interface CheckView {
  id: string;
  kind: "REGISTRATION" | "MANUAL" | "PERIODIC";
  status: "PENDING" | "RUNNING" | "DONE";
  ok: boolean | null;
  connectMs: number | null;
  latencyMs: number | null;
  serverVersion: string | null;
  tls: boolean | null;
  details: Record<string, unknown> | null;
  error: string | null;
  requestedBy: { id: string; fullName: string } | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AllocationView {
  id: string;
  status: "RESERVED" | "ASSIGNED" | "RELEASED" | "EXPIRED";
  school: { id: string; name: string; status: string };
  server: { id: string; name: string; kind: DatabaseServer["kind"] };
  reservedAt: Date;
  expiresAt: Date | null;
  assignedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  /** RESERVED mas fora do prazo (ainda não varrida) */
  expired: boolean;
  /** quantidade de dados da BD do colégio (medida pelo provisioner) */
  databaseBytes?: number | null;
}

export interface BackupView {
  id: string;
  school: { id: string; name: string; slug?: string | null };
  trigger: "MANUAL" | "AUTOMATIC" | "PRE_RESTORE";
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "DELETED";
  /** tamanho da cópia (cifrada) */
  sizeBytes: number | null;
  /** tamanho da BD no momento da cópia */
  databaseBytes: number | null;
  error: string | null;
  requestedBy: { id: string; fullName: string } | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Cópias de segurança: pedidas aqui, feitas pelo provisioner (fila database_backups). */
export interface BackupRepository {
  /** colégios com BD criada e atribuída a este servidor */
  schoolsOnServer(serverId: string): Promise<string[]>;
  hasDatabase(schoolId: string): Promise<boolean>;
  /** Cria pedidos MANUAL (ignora colégios com uma cópia já pendente). Devolve quantos criou. */
  request(schoolIds: string[], staffId: string): Promise<number>;
  forServer(serverId: string, limit: number): Promise<BackupView[]>;
  forSchool(schoolId: string, limit: number): Promise<BackupView[]>;
  schoolSlug(schoolId: string): Promise<string | null>;
  findBackup(backupId: string): Promise<{ id: string; schoolId: string; status: BackupView["status"]; createdAt: Date } | null>;
  /**
   * Pede o restauro (numa transação que bloqueia o colégio: no máximo um
   * restauro em curso). null = já há um restauro na fila ou a correr.
   */
  requestRestore(input: { schoolId: string; backupId: string; staffId: string; reason: string }): Promise<string | null>;
  restores(filter: { schoolId?: string; serverId?: string }, limit: number): Promise<RestoreView[]>;
}

export interface RestoreView {
  id: string;
  school: { id: string; name: string; slug: string | null };
  backupId: string;
  backupCreatedAt: Date;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  reason: string;
  requestedBy: { id: string; fullName: string } | null;
  safetyBackupId: string | null;
  rolledBack: boolean;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface ServerActivityView extends Omit<ServerEvent, "actorStaffId"> {
  id: string;
  actor: { id: string; fullName: string } | null;
}

export interface DatabaseServerRepository {
  findById(id: string): Promise<DatabaseServer | null>;
  endpointExists(endpoint: string, exceptId?: string): Promise<boolean>;
  /** Grava o agregado e os eventos. `sealedUrl` (se vier) substitui o segredo. */
  save(server: DatabaseServer, sealedUrl?: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** colégios atribuídos e reservas válidas */
  usage(id: string): Promise<{ assigned: number; reserved: number; everAssigned: number; usedBytes: number | null }>;
  /** Volta a pôr na fila a criação/ligação das BDs dos colégios deste servidor (ex.: senha da BD dedicada mudou). */
  requeueProvisioning(serverId: string): Promise<number>;
  requestCheck(serverId: string, kind: "REGISTRATION" | "MANUAL", staffId: string): Promise<string>;
}

export interface DatabaseServerQueries {
  list(): Promise<{ server: DatabaseServer; usage: { assigned: number; reserved: number; usedBytes: number | null }; recentLatency: (number | null)[] }[]>;
  checks(serverId: string, limit: number): Promise<CheckView[]>;
  check(serverId: string, checkId: string): Promise<CheckView | null>;
  allocations(serverId: string): Promise<AllocationView[]>;
  activity(serverId: string): Promise<ServerActivityView[]>;
}

export type SchoolDatabaseState =
  | "NONE"
  | "RESERVED"
  | "RESERVATION_EXPIRED"
  | "WAITING_SERVER"
  | "PROVISIONING"
  | "UPDATING"
  | "READY"
  | "FAILED";

export interface SchoolDatabaseStatus {
  state: SchoolDatabaseState;
  server: { id: string; name: string; kind: DatabaseServer["kind"] } | null;
  allocation: AllocationView | null;
  provisioning: { status: "PENDING" | "RUNNING" | "DONE" | "FAILED"; attempts: number; lastError: string | null; provisioned: boolean } | null;
  /** quantidade de dados e última cópia (null = a BD ainda não existe) */
  storage: { databaseBytes: number | null; measuredAt: Date | null; lastBackup: BackupView | null } | null;
}

/** Reservas/atribuições (com bloqueio de linhas para respeitar a capacidade). */
export interface PlacementStore {
  candidates(): Promise<PlacementCandidate[]>;
  schoolStatus(schoolId: string): Promise<string | null>;
  status(schoolId: string): Promise<SchoolDatabaseStatus>;
  /** serverIds por ordem de preferência; reserva no primeiro com espaço. */
  reserve(input: { schoolId: string; serverIds: string[]; staffId: string; expiresAt: Date }): Promise<Result<AllocationView, DatabaseError>>;
  release(input: { schoolId?: string; allocationId?: string; reason: string; staffId: string | null }): Promise<number>;
  /** Colégio ativo à espera de servidor → atribuir agora. */
  assignWaiting(input: { schoolId: string; serverId: string; staffId: string }): Promise<Result<AllocationView, DatabaseError>>;
}

export const DATABASE_TOKENS = {
  Repository: Symbol("DatabaseServerRepository"),
  Queries: Symbol("DatabaseServerQueries"),
  Sealer: Symbol("CredentialSealer"),
  PlacementStore: Symbol("PlacementStore"),
  Backups: Symbol("BackupRepository"),
} as const;
