import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import { checkReason, cleanText, dailyMirror, isDay } from "../domain/occurrences";
import { localNow } from "../domain/presence";
import { type AttendanceError, attendanceError, type AttendanceRules } from "../domain/settings";
import type { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import type { PendingRow, PrismaPendingsRepository, SubstitutionRow } from "../infrastructure/prisma-pendings";
import { DEADLINE_JOB } from "./DeadlineJob";
import type { OccurrencesRepository } from "./occurrence-ports";
import type { PresenceRepository } from "./presence-ports";

type PresenceLessonLookup = Pick<PresenceRepository, "lesson" | "yearOn" | "closureOn">;

type R<T> = Promise<Result<T, AttendanceError>>;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const STATUS: Record<string, string> = { OPEN: "Por decidir", SUBMITTED_LATE: "Registadas fora do prazo", FAULT: "Falta registada", DISMISSED: "Dispensada" };

const pendingDto = (p: PendingRow) => ({
  id: p.id,
  teacher: p.teacherId ? { id: p.teacherId, fullName: p.teacherName } : null,
  day: p.day,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  groupName: p.groupName,
  subjectName: p.subjectName,
  status: p.status,
  statusLabel: STATUS[p.status] ?? p.status,
  occurrenceId: p.occurrenceId,
  reason: p.reason,
  decidedBy: p.decidedByName,
  decidedAt: p.decidedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
});
const substitutionDto = (s: SubstitutionRow) => ({
  id: s.id,
  lessonId: s.lessonId,
  day: s.day,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  groupName: s.groupName,
  subjectName: s.subjectName,
  substitute: { id: s.substituteId, fullName: s.substituteName },
  original: s.originalId ? { id: s.originalId, fullName: s.originalName } : null,
  reason: s.reason,
  submitted: s.submitted,
});

/**
 * RH · aulas sem presenças no prazo (decidir: registar falta ou dispensar, com motivo) e
 * substituições (o substituto regista as presenças e responde pelo prazo dessa aula).
 * Ver: attendance.teachers.view · decidir/substituir: attendance.teachers.manage.
 */
export class Pendings {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async list(repo: PrismaPendingsRepository, jobs: PrismaDeadlineRepository, actor: { canManage: boolean }, rules: AttendanceRules, input: { status?: string; teacherId?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = 25;
    const [r, counts, runs] = await Promise.all([
      repo.list({ status: input.status && input.status in STATUS ? input.status : undefined, teacherId: input.teacherId, page, pageSize }),
      repo.counts(),
      jobs.runs(DEADLINE_JOB, 1),
    ]);
    const last = runs[0];
    return {
      canManage: actor.canManage,
      procedure: rules.missingProcedure,
      model: rules.teacherModel,
      deadlineMinutes: rules.deadlineMinutes,
      trackingSince: rules.trackingSince,
      counts,
      lastRun: last ? { at: last.started_at.toISOString(), status: last.status, stats: last.stats, error: last.error } : null,
      page,
      pageSize,
      total: r.total,
      items: r.items.map(pendingDto),
      statuses: Object.entries(STATUS).map(([value, label]) => ({ value, label })),
    };
  }

  /** Gestão manual: o RH regista a falta ao professor (no modelo do colégio: a aula ou o dia). */
  async fault(repo: PrismaPendingsRepository, occ: OccurrencesRepository, actor: { id: string; canManage: boolean }, rules: AttendanceRules, id: string, note: string | null, notify?: StaffNotify): R<{ occurrenceId: string }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para decidir as aulas pendentes."));
    const p = await repo.find(id);
    if (!p) return fail(attendanceError("NOT_FOUND", "Aula pendente não encontrada."));
    if (p.status !== "OPEN") return fail(attendanceError("INVALID_STATE", "Esta aula já foi decidida."));
    if (!p.teacherId) return fail(attendanceError("INVALID_STATE", "A aula não tem professor."));
    const now = this.clock.now();
    const perDay = rules.teacherModel === "PER_DAY";
    const occurrenceId = this.ids.next();
    const text = cleanText(note).slice(0, 300) || "Aula sem presenças no prazo (decisão do RH).";
    const created = await occ.create(
      [
        {
          id: occurrenceId,
          employeeId: p.teacherId,
          day: p.day,
          scope: perDay ? "DAY" : "LESSON",
          lesson: perDay ? null : { id: p.lessonId ?? "", startsAt: p.startsAt, endsAt: p.endsAt, groupName: p.groupName, subjectName: p.subjectName },
          kind: "FALTA",
          minutesLate: null,
          source: "MANUAL",
          note: text,
        },
      ],
      actor.id,
      now,
    );
    if (!created) return fail(attendanceError("OCCURRENCE_EXISTS", "O professor já tem uma ocorrência nessa aula (ou dia). Trate-a em Faltas dos professores."));
    if (perDay) await occ.mirrorDaily(p.teacherId, p.day, dailyMirror({ kind: "FALTA", minutesLate: null, status: "REGISTADA", justification: null }), actor.id, now);
    await repo.decide(id, "FAULT", occurrenceId, text, actor.id, now);
    await occ.record("TEACHER_OCCURRENCE_CREATED", occurrenceId, actor.id, { after: { kind: "FALTA", minutesLate: null, status: "REGISTADA", source: "MANUAL" }, reason: text }, now);
    await repo.record("LESSON_PENDING_DECIDED", id, actor.id, { decision: "FAULT", occurrenceId, reason: text }, now);
    await notify?.notify({
      kind: "TEACHER_OCCURRENCE",
      employeeIds: [p.teacherId],
      title: `Foi registada uma falta a ${dmy(p.day)}`,
      body: `${perDay ? "O dia" : `${p.startsAt} ${p.subjectName} (${p.groupName})`}: aula sem presenças no prazo. ${text} Se houver um motivo, fale com o RH para a justificar.`,
      link: `/presencas?data=${p.day}`,
    });
    return ok({ occurrenceId });
  }

  /** Gestão manual: o RH dispensa (há justificação, a aula foi dada…), sempre com motivo. */
  async dismiss(repo: PrismaPendingsRepository, actor: { id: string; canManage: boolean }, id: string, reason: string): R<{ dismissed: true }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para decidir as aulas pendentes."));
    const r = checkReason(reason);
    if (!r.ok) return r;
    const p = await repo.find(id);
    if (!p) return fail(attendanceError("NOT_FOUND", "Aula pendente não encontrada."));
    const now = this.clock.now();
    if (!(await repo.decide(id, "DISMISSED", null, r.value, actor.id, now))) return fail(attendanceError("INVALID_STATE", "Esta aula já foi decidida."));
    await repo.record("LESSON_PENDING_DECIDED", id, actor.id, { decision: "DISMISSED", reason: r.value }, now);
    return ok({ dismissed: true });
  }

  // ============================================================ substituições

  async substitutions(repo: PrismaPendingsRepository, rules: AttendanceRules) {
    const today = localNow(rules.timeZone, this.clock.now()).slice(0, 10);
    const from = new Date(new Date(`${today}T00:00:00Z`).getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    const list = await repo.substitutions(from);
    return { today, items: list.map(substitutionDto) };
  }

  async candidates(repo: PrismaPendingsRepository, lessons: PresenceLessonLookup, lessonId: string, day: string) {
    if (!isDay(day)) return fail(attendanceError("INVALID_INPUT", "Data inválida."));
    const l = await lessons.lesson(lessonId);
    if (!l) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    const rows = await repo.candidates(lessonId, day);
    return ok({ lesson: { id: l.id, groupName: l.groupName, subjectName: l.subjectName, startsAt: l.startsAt, endsAt: l.endsAt }, candidates: rows.map((c) => ({ id: c.id, fullName: c.full_name, hasPortal: c.has_portal, busy: c.busy })) });
  }

  async substitute(repo: PrismaPendingsRepository, lessons: PresenceLessonLookup, actor: { id: string; canManage: boolean }, input: { lessonId: string; day: string; substituteId: string; reason?: string | null }, notify?: StaffNotify): R<{ id: string }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para marcar substituições."));
    if (!isDay(input.day)) return fail(attendanceError("INVALID_INPUT", "Data inválida."));
    const l = await lessons.lesson(input.lessonId);
    const weekday = new Date(`${input.day}T00:00:00Z`).getUTCDay() || 7;
    if (!l || l.weekday !== weekday) return fail(attendanceError("NOT_FOUND", "Essa aula não acontece nesse dia."));
    const year = await lessons.yearOn(input.day);
    if (!year || year.id !== l.yearId) return fail(attendanceError("NOT_FOUND", "Esse dia não pertence ao ano letivo da aula."));
    const closure = await lessons.closureOn(year.id, input.day);
    if (closure) return fail(attendanceError("NO_CLASSES", `${closure.kindLabel}: ${closure.reason}. Não há aulas.`));
    if (input.substituteId === l.teacherId) return fail(attendanceError("INVALID_INPUT", "O substituto tem de ser outro professor."));
    const cands = await repo.candidates(l.id, input.day);
    const c = cands.find((x) => x.id === input.substituteId);
    if (!c) return fail(attendanceError("INVALID_INPUT", "Escolha um professor do colégio."));
    if (c.busy) return fail(attendanceError("INVALID_STATE", `${c.full_name} já tem aula a essa hora (${c.busy}).`));
    const reason = cleanText(input.reason).slice(0, 200) || null;
    const id = this.ids.next();
    const now = this.clock.now();
    if (!(await repo.createSubstitution({ id, lessonId: l.id, day: input.day, substituteId: c.id, originalId: l.teacherId, reason, actorId: actor.id, now })))
      return fail(attendanceError("OCCURRENCE_EXISTS", "Essa aula já tem uma substituição nesse dia. Retire-a primeiro."));
    await repo.record("LESSON_SUBSTITUTION_CREATED", id, actor.id, { lessonId: l.id, day: input.day, substituteId: c.id, originalId: l.teacherId, reason }, now);
    const what = `${dmy(input.day)} ${l.startsAt}–${l.endsAt} · ${l.subjectName} (${l.groupName})`;
    await notify?.notify({ kind: "SUBSTITUTION", employeeIds: [c.id], title: `Substituição a ${dmy(input.day)}`, body: `Vai dar a aula de ${what}${reason ? `. Motivo: ${reason}` : ""}. As presenças desta aula ficam a seu cargo.`, link: `/presencas?data=${input.day}` });
    if (l.teacherId) await notify?.notify({ kind: "SUBSTITUTION", employeeIds: [l.teacherId], title: `A sua aula de ${dmy(input.day)} tem substituição`, body: `${what}: substituída por ${c.full_name}${reason ? `. Motivo: ${reason}` : ""}.`, link: `/presencas?data=${input.day}` });
    return ok({ id });
  }

  async removeSubstitution(repo: PrismaPendingsRepository, actor: { id: string; canManage: boolean }, id: string, notify?: StaffNotify): R<{ removed: true }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para retirar substituições."));
    const s = await repo.substitution(id);
    if (!s) return fail(attendanceError("NOT_FOUND", "Substituição não encontrada."));
    if (s.submitted) return fail(attendanceError("INVALID_STATE", "As presenças desta aula já foram registadas pelo substituto: a substituição fica."));
    const now = this.clock.now();
    await repo.removeSubstitution(id);
    await repo.record("LESSON_SUBSTITUTION_REMOVED", id, actor.id, { lessonId: s.lessonId, day: s.day, substituteId: s.substituteId }, now);
    await notify?.notify({ kind: "SUBSTITUTION", employeeIds: [s.substituteId], title: `Substituição de ${dmy(s.day)} retirada`, body: `Já não dá a aula de ${s.startsAt} ${s.subjectName} (${s.groupName}).`, link: `/presencas?data=${s.day}` });
    return ok({ removed: true });
  }
}
