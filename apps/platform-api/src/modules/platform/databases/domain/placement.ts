import type { ServerHealth, ServerKind, ServerStatus } from "./DatabaseServer";

/** Servidor visto pela política de colocação. */
export interface PlacementCandidate {
  id: string;
  name: string;
  kind: ServerKind;
  status: ServerStatus;
  health: ServerHealth;
  region: string | null;
  capacity: number;
  /** colégios com a BD atribuída */
  assigned: number;
  /** reservas dentro do prazo */
  reserved: number;
  lastLatencyMs: number | null;
}

export const freeSlots = (c: Pick<PlacementCandidate, "capacity" | "assigned" | "reserved">) =>
  Math.max(0, c.capacity - c.assigned - c.reserved);

/** Pode receber um novo colégio? (motivo em português quando não pode) */
export function acceptsNewSchool(c: PlacementCandidate): { ok: true } | { ok: false; reason: string } {
  if (c.status !== "ACTIVE") return { ok: false, reason: "Servidor desativado." };
  if (c.health === "UNREACHABLE") return { ok: false, reason: "O último teste de ligação falhou." };
  if (freeSlots(c) === 0) return { ok: false, reason: c.kind === "DEDICATED_DATABASE" ? "Já está reservada/atribuída." : "Sem capacidade livre." };
  return { ok: true };
}

const HEALTH_RANK: Record<ServerHealth, number> = { HEALTHY: 0, DEGRADED: 1, UNKNOWN: 2, UNREACHABLE: 3 };

/**
 * Escolha automática: só servidores PARTILHADOS (uma BD dedicada é sempre uma
 * escolha deliberada da equipa). Prefere os saudáveis, depois os menos ocupados,
 * depois os mais rápidos.
 */
export function rankForAutoPlacement(candidates: PlacementCandidate[]): PlacementCandidate[] {
  return candidates
    .filter((c) => c.kind === "SHARED_SERVER" && acceptsNewSchool(c).ok)
    .sort(
      (a, b) =>
        HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
        (a.assigned + a.reserved) / a.capacity - (b.assigned + b.reserved) / b.capacity ||
        (a.lastLatencyMs ?? 9_999) - (b.lastLatencyMs ?? 9_999),
    );
}
