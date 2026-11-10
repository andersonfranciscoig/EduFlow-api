import type { Clock } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { RESERVATION_DAYS } from "../domain/DatabaseServer";
import { databaseError, type DatabaseError } from "../domain/errors";
import { acceptsNewSchool, rankForAutoPlacement } from "../domain/placement";
import { toAllocationDto, toCandidateDto, toSchoolDatabaseDto } from "./database-dto";
import type { PlacementStore } from "./ports";

/** "auto" = escolha automática; null = decidir mais tarde. */
export type PlacementChoice = "auto" | string | null;

const RESERVABLE = new Set(["PENDING_REVIEW", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW"]);

/**
 * Onde fica a BD de cada colégio:
 *   validação → RESERVA (prazo de RESERVATION_DAYS dias) → pagamento → ATRIBUIÇÃO.
 */
export class DatabasePlacement {
  constructor(
    private readonly store: PlacementStore,
    private readonly clock: Clock,
  ) {}

  async options(schoolId: string) {
    const [candidates, status] = await Promise.all([this.store.candidates(), this.store.status(schoolId)]);
    const recommended = rankForAutoPlacement(candidates)[0]?.id ?? null;
    return {
      reservationDays: RESERVATION_DAYS,
      recommendedId: recommended,
      servers: candidates.filter((c) => c.status === "ACTIVE").map(toCandidateDto),
      current: toSchoolDatabaseDto(status),
    };
  }

  async status(schoolId: string) {
    return toSchoolDatabaseDto(await this.store.status(schoolId));
  }

  /**
   * Reservar um servidor para o colégio.
   *  - "auto": o melhor servidor partilhado com espaço (sem nenhum → erro NO_CAPACITY)
   *  - id: aquele servidor (tem de ter espaço)
   */
  async reserve(schoolId: string, choice: "auto" | string, staffId: string): Promise<Result<ReturnType<typeof toAllocationDto>, DatabaseError>> {
    const schoolStatus = await this.store.schoolStatus(schoolId);
    if (!schoolStatus) return fail(databaseError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    if (!RESERVABLE.has(schoolStatus)) {
      return fail(databaseError("INVALID_STATE", "Só se reserva servidor a colégios em validação ou a aguardar pagamento."));
    }

    let serverIds: string[];
    if (choice === "auto") {
      serverIds = rankForAutoPlacement(await this.store.candidates()).map((c) => c.id);
      if (!serverIds.length) {
        return fail(databaseError("NO_CAPACITY", "Não há nenhum servidor partilhado com espaço. Registe um em Bases de dados."));
      }
    } else {
      const candidate = (await this.store.candidates()).find((c) => c.id === choice);
      if (!candidate) return fail(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
      const accepts = acceptsNewSchool(candidate);
      if (!accepts.ok) return fail(databaseError("NO_CAPACITY", accepts.reason));
      serverIds = [choice];
    }

    const expiresAt = new Date(this.clock.now().getTime() + RESERVATION_DAYS * 86_400_000);
    const result = await this.store.reserve({ schoolId, serverIds, staffId, expiresAt });
    return result.ok ? ok(toAllocationDto(result.value)) : result;
  }

  /** Usado na validação: "auto" sem servidores disponíveis não bloqueia (fica para depois). */
  async reserveOnApproval(schoolId: string, choice: PlacementChoice, staffId: string): Promise<Result<unknown, DatabaseError>> {
    if (choice === null) return ok(null);
    if (choice === "auto" && !rankForAutoPlacement(await this.store.candidates()).length) return ok(null);
    return this.reserve(schoolId, choice, staffId);
  }

  async release(schoolId: string, reason: string, staffId: string | null) {
    return this.store.release({ schoolId, reason, staffId });
  }

  async releaseAllocation(allocationId: string, staffId: string): Promise<Result<void, DatabaseError>> {
    const released = await this.store.release({ allocationId, reason: "Libertada pela equipa", staffId });
    return released ? ok(undefined) : fail(databaseError("ALLOCATION_NOT_FOUND", "Reserva não encontrada (ou já atribuída/libertada)."));
  }

  async assign(schoolId: string, serverId: string, staffId: string) {
    const result = await this.store.assignWaiting({ schoolId, serverId, staffId });
    return result.ok ? ok(await this.status(schoolId)) : result;
  }
}
