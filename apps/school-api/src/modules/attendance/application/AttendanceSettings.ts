import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import {
  type AttendanceError,
  type AttendanceRules,
  attendanceError,
  checkRules,
  DEFAULT_RULES,
  diffRules,
  MISSING_PROCEDURES,
  type MissingProcedure,
  TEACHER_MODELS,
  type TeacherModel,
  TIME_ZONES,
} from "../domain/settings";
import type { AttendanceActor, AttendanceSettingsRepository } from "./ports";

const pick = (r: AttendanceRules): AttendanceRules => ({
  teacherModel: r.teacherModel,
  missingProcedure: r.missingProcedure,
  deadlineMinutes: r.deadlineMinutes,
  absenceLimit: r.absenceLimit,
  consecutiveLimit: r.consecutiveLimit,
  timeZone: r.timeZone,
});

/**
 * Regras de assiduidade do colégio. Ver: attendance.access · alterar: attendance.settings.manage.
 * Cada alteração fica no histórico (quem, quando, antes → depois, motivo).
 */
export class AttendanceSettings {
  constructor(private readonly clock: Clock) {}

  /** As regras em vigor (as por omissão enquanto o colégio não as configurar). */
  async rules(repo: AttendanceSettingsRepository): Promise<AttendanceRules> {
    const r = await repo.get();
    return r ? pick(r) : DEFAULT_RULES;
  }

  async view(repo: AttendanceSettingsRepository, actor: AttendanceActor) {
    const [r, history] = await Promise.all([repo.get(), repo.history(20)]);
    return {
      canManage: actor.canManage,
      configured: !!r,
      rules: r ? pick(r) : DEFAULT_RULES,
      updatedAt: r?.updatedAt.toISOString() ?? null,
      updatedBy: r?.updatedByName ?? null,
      options: {
        teacherModels: (Object.keys(TEACHER_MODELS) as TeacherModel[]).map((v) => ({ value: v, ...TEACHER_MODELS[v] })),
        missingProcedures: (Object.keys(MISSING_PROCEDURES) as MissingProcedure[]).map((v) => ({ value: v, ...MISSING_PROCEDURES[v] })),
        timeZones: TIME_ZONES,
      },
      history: history.map((h) => ({ at: h.at.toISOString(), by: h.actorName, reason: h.reason, changes: h.changes })),
    };
  }

  async update(repo: AttendanceSettingsRepository, actor: AttendanceActor, input: AttendanceRules & { reason?: string | null }): Promise<Result<{ changed: number }, AttendanceError>> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para alterar as regras de assiduidade."));
    const checked = checkRules(pick(input));
    if (!checked.ok) return checked;
    const before = await this.rules(repo);
    const changes = diffRules(before, checked.value);
    const n = Object.keys(changes).length;
    if (!n) return ok({ changed: 0 });
    const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
    if (reason && reason.length > 300) return fail(attendanceError("INVALID_INPUT", "O motivo tem no máximo 300 caracteres."));
    const now = this.clock.now();
    await repo.save(checked.value, actor.id, now);
    await repo.record("ATTENDANCE_SETTINGS_UPDATED", actor.id, { changes, reason }, now);
    return ok({ changed: n });
  }
}
