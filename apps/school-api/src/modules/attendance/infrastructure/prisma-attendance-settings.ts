import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { AttendanceSettingsRepository, RulesChangeRow } from "../application/ports";
import type { AttendanceRules, MissingProcedure, TeacherModel } from "../domain/settings";

/** As regras ficam na linha única de `attendance_settings`; o histórico em `school_activity`. */
const SUBJECT = "00000000-0000-0000-0000-000000000a77";

export class PrismaAttendanceSettingsRepository implements AttendanceSettingsRepository {
  constructor(private readonly db: PrismaClient) {}

  async get() {
    const rows = await this.db.$queryRaw<
      { teacher_model: string; missing_procedure: string; deadline_minutes: number; absence_limit: number; consecutive_limit: number; time_zone: string; updated_at: Date; by: string | null }[]
    >`SELECT s.teacher_model, s.missing_procedure, s.deadline_minutes, s.absence_limit, s.consecutive_limit, s.time_zone, s.updated_at, u.full_name AS by
        FROM attendance_settings s LEFT JOIN school_users u ON u.id = s.updated_by_id WHERE s.id = 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      teacherModel: r.teacher_model as TeacherModel,
      missingProcedure: r.missing_procedure as MissingProcedure,
      deadlineMinutes: r.deadline_minutes,
      absenceLimit: r.absence_limit,
      consecutiveLimit: r.consecutive_limit,
      timeZone: r.time_zone,
      updatedAt: r.updated_at,
      updatedByName: r.by,
    };
  }

  async save(rules: AttendanceRules, actorId: string | null, now: Date) {
    await this.db.attendanceSettings.upsert({ where: { id: 1 }, update: { ...rules, updatedById: actorId, updatedAt: now }, create: { id: 1, ...rules, updatedById: actorId, updatedAt: now } });
  }

  async record(type: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId: SUBJECT, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  async history(limit: number): Promise<RulesChangeRow[]> {
    const rows = await this.db.$queryRaw<{ occurred_at: Date; details: { changes?: RulesChangeRow["changes"]; reason?: string | null } | null; by: string | null }[]>`
      SELECT a.occurred_at, a.details, u.full_name AS by
        FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ${SUBJECT}::uuid AND a.type = 'ATTENDANCE_SETTINGS_UPDATED'
       ORDER BY a.occurred_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ at: r.occurred_at, actorName: r.by, changes: r.details?.changes ?? {}, reason: r.details?.reason ?? null }));
  }
}
