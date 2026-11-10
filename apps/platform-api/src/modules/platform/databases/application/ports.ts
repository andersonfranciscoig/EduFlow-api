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
  usage(id: string): Promise<{ assigned: number; reserved: number; everAssigned: number }>;
  /** Volta a pôr na fila a criação/ligação das BDs dos colégios deste servidor (ex.: senha da BD dedicada mudou). */
  requeueProvisioning(serverId: string): Promise<number>;
  requestCheck(serverId: string, kind: "REGISTRATION" | "MANUAL", staffId: string): Promise<string>;
}

export interface DatabaseServerQueries {
  list(): Promise<{ server: DatabaseServer; usage: { assigned: number; reserved: number }; recentLatency: (number | null)[] }[]>;
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
} as const;
