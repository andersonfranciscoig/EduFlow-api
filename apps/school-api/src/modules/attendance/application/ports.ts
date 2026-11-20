import type { AttendanceRules } from "../domain/settings";

export interface RulesChangeRow {
  at: Date;
  actorName: string | null;
  changes: Record<string, { before: unknown; after: unknown }>;
  reason: string | null;
}

export interface AttendanceSettingsRepository {
  /** null = ainda nunca configurado (valem as regras por omissão). */
  get(): Promise<(AttendanceRules & { updatedAt: Date; updatedByName: string | null }) | null>;
  save(rules: AttendanceRules, actorId: string | null, now: Date): Promise<void>;
  /** cria a linha (com a data de início do controlo = hoje) se ainda não existir */
  ensure(now: Date): Promise<void>;
  record(type: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
  history(limit: number): Promise<RulesChangeRow[]>;
}

export interface AttendanceActor {
  id: string;
  /** permissões já resolvidas (attendance.settings.manage…) */
  canManage: boolean;
}
