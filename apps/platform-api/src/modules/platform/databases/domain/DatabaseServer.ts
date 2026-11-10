import type { PostgresUrl, SslMode } from "../../../../../../../libs/kernel/src/domain/postgres-url";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { databaseError, type DatabaseError } from "./errors";

export type ServerKind = "SHARED_SERVER" | "DEDICATED_DATABASE";
export type ServerStatus = "ACTIVE" | "DISABLED";
export type ServerHealth = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNREACHABLE";

export const MAX_SHARED_CAPACITY = 500;
/** Prazo de uma reserva feita na validação do colégio. */
export const RESERVATION_DAYS = 7;

export type ServerActivityType =
  | "SERVER_REGISTERED"
  | "SERVER_UPDATED"
  | "CREDENTIALS_ROTATED"
  | "SERVER_DISABLED"
  | "SERVER_ENABLED"
  | "DATABASE_RESERVED"
  | "RESERVATION_RELEASED"
  | "DATABASE_ASSIGNED";

export interface ServerEvent {
  type: ServerActivityType;
  actorStaffId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
}

/** Ligação sem segredos (o URL completo nunca fica no agregado). */
export interface ServerEndpoint {
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: SslMode;
  endpoint: string;
}

export interface ServerHealthState {
  health: ServerHealth;
  lastCheckedAt: Date | null;
  lastLatencyMs: number | null;
  serverVersion: string | null;
  tlsActive: boolean | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface DatabaseServerProps extends ServerEndpoint {
  id: string;
  name: string;
  kind: ServerKind;
  status: ServerStatus;
  region: string | null;
  notes: string | null;
  capacity: number;
  /** Só o provisioner altera a saúde; aqui é apenas leitura. */
  healthState: ServerHealthState;
  credentialsUpdatedAt: Date;
  createdById: string | null;
  createdAt: Date;
}

export interface ServerSettings {
  name: string;
  capacity: number;
  region: string | null;
  notes: string | null;
}

const UNKNOWN_HEALTH: ServerHealthState = {
  health: "UNKNOWN",
  lastCheckedAt: null,
  lastLatencyMs: null,
  serverVersion: null,
  tlsActive: null,
  lastError: null,
  consecutiveFailures: 0,
};

function toEndpoint(url: PostgresUrl): ServerEndpoint {
  return { host: url.host, port: url.port, database: url.database, username: url.user, sslMode: url.sslMode, endpoint: url.endpoint };
}

function validateSettings(kind: ServerKind, input: ServerSettings, used: number): Result<ServerSettings, DatabaseError> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return fail(databaseError("INVALID_SERVER", "Dê um nome ao servidor (2 a 80 caracteres)."));
  const capacity = kind === "DEDICATED_DATABASE" ? 1 : input.capacity;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SHARED_CAPACITY) {
    return fail(databaseError("INVALID_SERVER", `A capacidade tem de estar entre 1 e ${MAX_SHARED_CAPACITY} colégios.`));
  }
  if (capacity < used) {
    return fail(databaseError("INVALID_SERVER", `Já há ${used} colégio(s) neste servidor — a capacidade não pode ser menor.`));
  }
  const clean = (v: string | null) => (v?.trim() ? v.trim().slice(0, 500) : null);
  return ok({ name, capacity, region: clean(input.region)?.slice(0, 60) ?? null, notes: clean(input.notes) });
}

/**
 * Agregado: servidor/BD onde vivem as bases de dados dos colégios.
 *  - SHARED_SERVER: o provisioner cria lá uma BD + utilizador por colégio.
 *  - DEDICATED_DATABASE: uma BD já existente, só para um colégio.
 * O URL de ligação é selado (cifrado) fora do domínio e nunca volta a ser lido pela plataforma.
 */
export class DatabaseServer {
  private events: ServerEvent[] = [];

  private constructor(private props: DatabaseServerProps) {}

  static register(input: {
    id: string;
    kind: ServerKind;
    url: PostgresUrl;
    settings: ServerSettings;
    actorId: string;
    now: Date;
  }): Result<DatabaseServer, DatabaseError> {
    if (input.kind === "DEDICATED_DATABASE" && input.url.database === "postgres") {
      return fail(databaseError("INVALID_URL", "Indique no URL a base de dados dedicada ao colégio (não a base \"postgres\")."));
    }
    const settings = validateSettings(input.kind, input.settings, 0);
    if (!settings.ok) return settings;

    const server = new DatabaseServer({
      id: input.id,
      kind: input.kind,
      status: "ACTIVE",
      ...settings.value,
      ...toEndpoint(input.url),
      healthState: UNKNOWN_HEALTH,
      credentialsUpdatedAt: input.now,
      createdById: input.actorId,
      createdAt: input.now,
    });
    server.record("SERVER_REGISTERED", input.actorId, input.now, {
      kind: input.kind,
      endpoint: input.url.endpoint,
      capacity: settings.value.capacity,
    });
    return ok(server);
  }

  static restore(props: DatabaseServerProps) {
    return new DatabaseServer({ ...props });
  }

  updateSettings(input: ServerSettings, used: number, actorId: string, now: Date): Result<void, DatabaseError> {
    const settings = validateSettings(this.props.kind, input, used);
    if (!settings.ok) return settings;
    const before = { name: this.props.name, capacity: this.props.capacity, region: this.props.region, notes: this.props.notes };
    const changes = Object.fromEntries(
      Object.entries(settings.value).filter(([k, v]) => before[k as keyof ServerSettings] !== v).map(([k, v]) => [k, { from: before[k as keyof ServerSettings], to: v }]),
    );
    if (!Object.keys(changes).length) return ok(undefined);
    Object.assign(this.props, settings.value);
    this.record("SERVER_UPDATED", actorId, now, { changes });
    return ok(undefined);
  }

  /**
   * Trocar o URL (ex.: senha rodada). Com colégios atribuídos não se pode mudar
   * de servidor/base — só de utilizador/senha.
   */
  rotateCredentials(url: PostgresUrl, assigned: number, actorId: string, now: Date): Result<void, DatabaseError> {
    if (this.props.kind === "DEDICATED_DATABASE" && url.database === "postgres") {
      return fail(databaseError("INVALID_URL", "Indique no URL a base de dados dedicada ao colégio."));
    }
    const moved = url.host !== this.props.host || url.port !== this.props.port || url.database !== this.props.database;
    if (assigned > 0 && moved) {
      return fail(
        databaseError("SERVER_IN_USE", "Há colégios com dados neste servidor: só pode mudar o utilizador e a senha, não o servidor nem a base."),
      );
    }
    const previous = this.props.endpoint;
    Object.assign(this.props, toEndpoint(url));
    this.props.credentialsUpdatedAt = now;
    this.props.healthState = UNKNOWN_HEALTH;
    this.record("CREDENTIALS_ROTATED", actorId, now, { from: previous, to: url.endpoint });
    return ok(undefined);
  }

  disable(actorId: string, now: Date): Result<void, DatabaseError> {
    if (this.props.status === "DISABLED") return fail(databaseError("INVALID_STATE", "O servidor já está desativado."));
    this.props.status = "DISABLED";
    this.record("SERVER_DISABLED", actorId, now, null);
    return ok(undefined);
  }

  enable(actorId: string, now: Date): Result<void, DatabaseError> {
    if (this.props.status === "ACTIVE") return fail(databaseError("INVALID_STATE", "O servidor já está ativo."));
    this.props.status = "ACTIVE";
    this.record("SERVER_ENABLED", actorId, now, null);
    return ok(undefined);
  }

  private record(type: ServerActivityType, actorStaffId: string | null, now: Date, details: Record<string, unknown> | null) {
    this.events.push({ type, actorStaffId, details, occurredAt: now });
  }

  pullEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  get id() { return this.props.id; }
  get kind() { return this.props.kind; }
  get status() { return this.props.status; }
  get snapshot(): Readonly<DatabaseServerProps> { return this.props; }
}
