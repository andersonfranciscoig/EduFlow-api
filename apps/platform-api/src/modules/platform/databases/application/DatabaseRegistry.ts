import type { Clock, IdGenerator } from "../../../../../../../libs/kernel/src/application/ports";
import { parsePostgresUrl } from "../../../../../../../libs/kernel/src/domain/postgres-url";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { DatabaseServer, type ServerKind, type ServerSettings } from "../domain/DatabaseServer";
import { databaseError, type DatabaseError } from "../domain/errors";
import { toActivityDto, toAllocationDto, toCheckDto, toServerSummary } from "./database-dto";
import type { CredentialSealer, DatabaseServerQueries, DatabaseServerRepository } from "./ports";

/**
 * Registo dos servidores de BD (equipa). O URL é validado, selado com a chave
 * pública do provisioner e esquecido — a plataforma nunca o volta a ver.
 * Os testes de ligação são feitos pelo provisioner (fila database_server_checks).
 */
export class DatabaseRegistry {
  constructor(
    private readonly servers: DatabaseServerRepository,
    private readonly queries: DatabaseServerQueries,
    private readonly sealer: CredentialSealer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private async load(id: string): Promise<Result<DatabaseServer, DatabaseError>> {
    const server = await this.servers.findById(id);
    return server ? ok(server) : fail(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
  }

  private parse(kind: ServerKind, url: string) {
    const parsed = parsePostgresUrl(url, { requireDatabase: kind === "DEDICATED_DATABASE" });
    return parsed.ok ? ok(parsed.value) : fail(databaseError("INVALID_URL", parsed.error));
  }

  async list() {
    const rows = await this.queries.list();
    const servers = rows.map((r) => toServerSummary(r.server, r.usage, r.recentLatency));
    const active = servers.filter((s) => s.status === "ACTIVE");
    return {
      servers,
      totals: {
        servers: servers.length,
        active: active.length,
        healthy: active.filter((s) => s.health === "HEALTHY").length,
        attention: active.filter((s) => s.health === "UNREACHABLE" || s.health === "DEGRADED").length,
        capacity: active.reduce((n, s) => n + s.capacity, 0),
        assigned: servers.reduce((n, s) => n + s.assigned, 0),
        reserved: servers.reduce((n, s) => n + s.reserved, 0),
      },
    };
  }

  async detail(id: string) {
    const server = await this.load(id);
    if (!server.ok) return server;
    const [usage, allocations, checks, activity] = await Promise.all([
      this.servers.usage(id),
      this.queries.allocations(id),
      this.queries.checks(id, 48),
      this.queries.activity(id),
    ]);
    const latency = [...checks].reverse().filter((c) => c.status === "DONE").map((c) => (c.ok ? c.latencyMs : null));
    return ok({
      ...toServerSummary(server.value, usage, latency.slice(-24)),
      canDelete: usage.everAssigned === 0 && usage.reserved === 0,
      allocations: allocations.map(toAllocationDto),
      checks: checks.map(toCheckDto),
      activity: activity.map(toActivityDto),
    });
  }

  async register(input: { kind: ServerKind; url: string } & ServerSettings, staffId: string) {
    const url = this.parse(input.kind, input.url);
    if (!url.ok) return url;
    if (await this.servers.endpointExists(url.value.endpoint)) {
      return fail(databaseError("ENDPOINT_TAKEN", "Este servidor/base de dados (mesmo utilizador) já está registado."));
    }
    const created = DatabaseServer.register({
      id: this.ids.next(),
      kind: input.kind,
      url: url.value,
      settings: input,
      actorId: staffId,
      now: this.clock.now(),
    });
    if (!created.ok) return created;

    await this.servers.save(created.value, this.sealer.seal(input.url.trim()));
    const checkId = await this.servers.requestCheck(created.value.id, "REGISTRATION", staffId);
    const detail = await this.detail(created.value.id);
    return detail.ok ? ok({ server: detail.value, checkId }) : detail;
  }

  async updateSettings(id: string, input: ServerSettings, staffId: string) {
    const server = await this.load(id);
    if (!server.ok) return server;
    const usage = await this.servers.usage(id);
    const result = server.value.updateSettings(input, usage.assigned + usage.reserved, staffId, this.clock.now());
    if (!result.ok) return result;
    await this.servers.save(server.value);
    return this.detail(id);
  }

  async rotateCredentials(id: string, rawUrl: string, staffId: string) {
    const server = await this.load(id);
    if (!server.ok) return server;
    const url = this.parse(server.value.kind, rawUrl);
    if (!url.ok) return url;
    if (await this.servers.endpointExists(url.value.endpoint, id)) {
      return fail(databaseError("ENDPOINT_TAKEN", "Este servidor/base de dados (mesmo utilizador) já está registado."));
    }
    const usage = await this.servers.usage(id);
    const result = server.value.rotateCredentials(url.value, usage.assigned, staffId, this.clock.now());
    if (!result.ok) return result;

    await this.servers.save(server.value, this.sealer.seal(rawUrl.trim()));
    // BD dedicada: o colégio usa estas credenciais → o provisioner atualiza o diretório
    if (server.value.kind === "DEDICATED_DATABASE" && usage.everAssigned > 0) await this.servers.requeueProvisioning(id);
    const checkId = await this.servers.requestCheck(id, "MANUAL", staffId);
    const detail = await this.detail(id);
    return detail.ok ? ok({ server: detail.value, checkId }) : detail;
  }

  async setEnabled(id: string, enabled: boolean, staffId: string) {
    const server = await this.load(id);
    if (!server.ok) return server;
    const result = enabled ? server.value.enable(staffId, this.clock.now()) : server.value.disable(staffId, this.clock.now());
    if (!result.ok) return result;
    await this.servers.save(server.value);
    return this.detail(id);
  }

  async remove(id: string): Promise<Result<void, DatabaseError>> {
    const server = await this.load(id);
    if (!server.ok) return server;
    const usage = await this.servers.usage(id);
    if (usage.everAssigned > 0 || usage.reserved > 0) {
      return fail(databaseError("SERVER_IN_USE", "Este servidor tem (ou teve) colégios — desative-o em vez de o apagar."));
    }
    await this.servers.remove(id);
    return ok(undefined);
  }

  async requestCheck(id: string, staffId: string) {
    const server = await this.load(id);
    if (!server.ok) return server;
    return ok({ checkId: await this.servers.requestCheck(id, "MANUAL", staffId) });
  }

  async check(id: string, checkId: string) {
    const check = await this.queries.check(id, checkId);
    return check ? ok(toCheckDto(check)) : fail(databaseError("CHECK_NOT_FOUND", "Teste não encontrado."));
  }
}
