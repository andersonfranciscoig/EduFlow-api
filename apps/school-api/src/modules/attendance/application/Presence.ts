import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { isDay } from "../domain/occurrences";
import { checkMarks, lessonState, localNow, type Mark, type MarkInput, PRESENCE_LABELS, type PresenceStatus, rate, STATE_LABELS } from "../domain/presence";
import { type AttendanceError, attendanceError, type AttendanceRules } from "../domain/settings";
import type { GroupRow, PresenceRepository, SessionMarkRow, SessionRow } from "./presence-ports";

type R<T> = Promise<Result<T, AttendanceError>>;
const gradeName = (g: number) => (g === 0 ? "Iniciação" : `${g}.ª Classe`);
const sessionDto = (s: SessionRow) => ({
  id: s.id,
  day: s.day,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  group: { id: s.groupId, name: s.groupName },
  subjectName: s.subjectName,
  teacherName: s.teacherName,
  submittedAt: s.submittedAt.toISOString(),
  submittedBy: s.submittedByName,
  late: s.late,
  corrected: s.updatedAt.getTime() - s.submittedAt.getTime() > 1000,
  counts: s.counts,
  rate: rate(s.counts),
});
const groupDto = (g: GroupRow) => ({ id: g.id, name: g.name, classId: g.classId, grade: g.grade, gradeName: gradeName(g.grade), courseName: g.courseName, shift: g.shift, students: g.students, sessions: g.sessions });
const markDto = (m: SessionMarkRow) => ({ studentId: m.studentId, fullName: m.fullName, number: m.number, status: m.status, statusLabel: PRESENCE_LABELS[m.status], minutesLate: m.minutesLate, note: m.note });
const statuses = Object.entries(PRESENCE_LABELS).map(([value, label]) => ({ value, label }));

/** O que mudou entre as presenças antigas e as novas (para o histórico). */
function diff(before: SessionMarkRow[], after: Mark[], names: Map<string, string>) {
  const old = new Map(before.map((m) => [m.studentId, m]));
  return after
    .filter((m) => {
      const o = old.get(m.studentId);
      return !o || o.status !== m.status || o.minutesLate !== m.minutesLate || (o.note ?? null) !== m.note;
    })
    .map((m) => ({ studentId: m.studentId, fullName: names.get(m.studentId) ?? old.get(m.studentId)?.fullName ?? "", before: old.get(m.studentId)?.status ?? null, after: m.status }));
}

/**
 * Presenças dos alunos.
 *  Professor (a conta ligada a um funcionário): as suas aulas do dia (do horário), a lista da
 *  turma e a submissão — a partir do início da aula; corrige até ao fim do prazo; depois do prazo
 *  ainda pode submeter (fica "fora do prazo"), mas não corrigir. Vê o histórico das suas turmas.
 *  Gestão: attendance.students.view (consultar) · attendance.students.edit (corrigir, com motivo).
 */
export class Presence {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private async teacher(repo: PresenceRepository, userId: string): R<{ id: string; fullName: string }> {
    const t = await repo.employeeOfUser(userId);
    return t ? ok(t) : fail(attendanceError("FORBIDDEN", "A sua conta não está ligada a um professor."));
  }

  // ============================================================ professor

  async myDay(repo: PresenceRepository, rules: AttendanceRules, userId: string, day?: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const now = localNow(rules.timeZone, this.clock.now());
    const today = now.slice(0, 10);
    const d = day && isDay(day) ? day : today;
    const year = await repo.yearOn(d);
    const closure = year ? await repo.closureOn(year.id, d) : null;
    const lessons = year && !closure ? await repo.teacherLessons(t.value.id, year.id, d) : [];
    return ok({
      teacher: t.value,
      today,
      day: d,
      year,
      closure,
      deadlineMinutes: rules.deadlineMinutes,
      lessons: lessons.map((l) => {
        const s = lessonState(d, l.startsAt, l.endsAt, rules.deadlineMinutes, now, !!l.session);
        return {
          lessonId: l.lessonId,
          startsAt: l.startsAt,
          endsAt: l.endsAt,
          group: { id: l.groupId, name: l.groupName },
          subject: { name: l.subjectName, color: l.subjectColor },
          room: l.room,
          state: s.state,
          stateLabel: STATE_LABELS[s.state],
          deadline: s.deadline.slice(11),
          session: l.session ? { id: l.session.id, late: l.session.late, counts: l.session.counts } : null,
        };
      }),
    });
  }

  /** A aula de um dia: valida que é do professor, nesse dia da semana, num dia de aulas. */
  private async ownLesson(repo: PresenceRepository, rules: AttendanceRules, teacherId: string, lessonId: string, day: string) {
    if (!isDay(day)) return fail(attendanceError("INVALID_INPUT", "Data inválida."));
    const l = await repo.lesson(lessonId);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    if (!l || l.teacherId !== teacherId || l.weekday !== weekday) return fail(attendanceError("NOT_FOUND", "Aula não encontrada no seu horário nesse dia."));
    const year = await repo.yearOn(day);
    if (!year || year.id !== l.yearId) return fail(attendanceError("NOT_FOUND", "Esse dia não pertence ao ano letivo desta aula."));
    const closure = await repo.closureOn(year.id, day);
    if (closure) return fail(attendanceError("NO_CLASSES", `${closure.kindLabel}: ${closure.reason}. Não há aulas.`));
    const now = localNow(rules.timeZone, this.clock.now());
    const existing = await repo.sessionAt(l.groupId, day, l.startsAt);
    const st = lessonState(day, l.startsAt, l.endsAt, rules.deadlineMinutes, now, !!existing);
    return ok({ lesson: l, existing, ...st });
  }

  async myLesson(repo: PresenceRepository, rules: AttendanceRules, userId: string, lessonId: string, day: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const own = await this.ownLesson(repo, rules, t.value.id, lessonId, day);
    if (!own.ok) return own;
    const { lesson: l, existing, state, deadline, beforeDeadline, started } = own.value;
    const [roster, marks] = await Promise.all([repo.roster(l.groupId), existing ? repo.marks(existing.id) : []]);
    const byId = new Map(marks.map((m) => [m.studentId, m]));
    return ok({
      lesson: { id: l.id, day, startsAt: l.startsAt, endsAt: l.endsAt, group: { id: l.groupId, name: l.groupName }, subjectName: l.subjectName },
      state,
      stateLabel: STATE_LABELS[state],
      deadline: deadline.slice(11),
      /** pode marcar/submeter agora (depois do início; corrigir só até ao fim do prazo) */
      canSubmit: started && (!existing || beforeDeadline),
      session: existing ? sessionDto(existing) : null,
      statuses,
      students: roster.map((s) => {
        const m = byId.get(s.id);
        return { id: s.id, fullName: s.fullName, number: s.number, status: m?.status ?? null, minutesLate: m?.minutesLate ?? null, note: m?.note ?? null };
      }),
    });
  }

  async submit(repo: PresenceRepository, rules: AttendanceRules, actor: { userId: string }, lessonId: string, day: string, input: MarkInput[]): R<{ sessionId: string; late: boolean; counts: ReturnType<typeof sessionDto>["counts"] }> {
    const t = await this.teacher(repo, actor.userId);
    if (!t.ok) return t;
    const own = await this.ownLesson(repo, rules, t.value.id, lessonId, day);
    if (!own.ok) return own;
    const { lesson: l, existing, beforeDeadline, started } = own.value;
    if (!started) return fail(attendanceError("INVALID_STATE", "A aula ainda não começou."));
    if (existing && !beforeDeadline) return fail(attendanceError("DEADLINE_PASSED", "Passou o prazo: as presenças já não se alteram aqui. Peça a correção à direção pedagógica."));
    const roster = await repo.roster(l.groupId);
    if (!roster.length) return fail(attendanceError("INVALID_STATE", "A turma não tem alunos matriculados."));
    const checked = checkMarks(
      roster.map((s) => s.id),
      input,
    );
    if (!checked.ok) return checked;
    const now = this.clock.now();
    const before = existing ? await repo.marks(existing.id) : [];
    const late = existing ? existing.late : !beforeDeadline;
    const id = await repo.saveSession(
      { id: this.ids.next(), lessonId: l.id, yearId: l.yearId, groupId: l.groupId, subjectId: l.subjectId, teacherId: t.value.id, day, startsAt: l.startsAt, endsAt: l.endsAt, late },
      checked.value,
      actor.userId,
      now,
    );
    const names = new Map(roster.map((s) => [s.id, s.fullName]));
    const changes = diff(before, checked.value, names);
    if (!existing) await repo.record("LESSON_ATTENDANCE_SUBMITTED", id, actor.userId, { late, total: checked.value.length }, now);
    else if (changes.length) await repo.record("LESSON_ATTENDANCE_UPDATED", id, actor.userId, { changes, reason: null }, now);
    const s = await repo.sessionById(id);
    return ok({ sessionId: id, late, counts: s?.counts ?? { present: 0, absent: 0, late: 0, justified: 0, total: 0 } });
  }

  async myGroups(repo: PresenceRepository, userId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const groups = await repo.teacherGroups(t.value.id);
    return ok({ teacher: t.value, groups: groups.map((g) => ({ ...groupDto(g), subjects: g.subjects })) });
  }

  async myGroup(repo: PresenceRepository, userId: string, groupId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const groups = await repo.teacherGroups(t.value.id);
    const g = groups.find((x) => x.id === groupId);
    if (!g) return fail(attendanceError("NOT_FOUND", "Turma não encontrada nas suas turmas."));
    const [sessions, students] = await Promise.all([repo.groupSessions(groupId, t.value.id), repo.groupStudents(groupId)]);
    return ok({ group: { ...groupDto(g), subjects: g.subjects }, sessions: sessions.map(sessionDto), students: students.map((s) => ({ ...s, rate: rate(s.counts) })) });
  }

  async mySession(repo: PresenceRepository, userId: string, sessionId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const s = await repo.sessionById(sessionId);
    if (!s || s.teacherId !== t.value.id) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    return ok({ session: sessionDto(s), marks: (await repo.marks(s.id)).map(markDto) });
  }

  // ============================================================ gestão (pedagógico)

  async groups(repo: PresenceRepository, rules: AttendanceRules, yearId?: string) {
    const today = localNow(rules.timeZone, this.clock.now()).slice(0, 10);
    const year = yearId ? { id: yearId, name: "" } : await repo.currentYear(today);
    if (!year) return { year: null, groups: [] };
    return { year, groups: (await repo.yearGroups(year.id)).map(groupDto) };
  }

  async group(repo: PresenceRepository, groupId: string) {
    const g = await repo.group(groupId);
    if (!g) return fail(attendanceError("NOT_FOUND", "Turma não encontrada."));
    const [sessions, students] = await Promise.all([repo.groupSessions(groupId), repo.groupStudents(groupId)]);
    const total = sessions.reduce((a, s) => ({ present: a.present + s.counts.present, absent: a.absent + s.counts.absent, late: a.late + s.counts.late, justified: a.justified + s.counts.justified, total: a.total + s.counts.total }), { present: 0, absent: 0, late: 0, justified: 0, total: 0 });
    return ok({ group: groupDto(g), totals: { ...total, rate: rate(total) }, sessions: sessions.map(sessionDto), students: students.map((s) => ({ ...s, rate: rate(s.counts) })) });
  }

  async session(repo: PresenceRepository, actor: { canEdit: boolean }, sessionId: string) {
    const s = await repo.sessionById(sessionId);
    if (!s) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    const [marks, history] = await Promise.all([repo.marks(s.id), repo.history(s.id)]);
    return ok({
      canEdit: actor.canEdit,
      session: sessionDto(s),
      statuses,
      marks: marks.map(markDto),
      history: history.map((h) => ({
        at: h.at.toISOString(),
        action: h.type.replace("LESSON_ATTENDANCE_", ""),
        actionLabel: { SUBMITTED: "Presenças submetidas", UPDATED: "Alteradas pelo professor", CORRECTED: "Corrigidas" }[h.type.replace("LESSON_ATTENDANCE_", "")] ?? h.type,
        by: h.actorName,
        reason: h.details?.reason ?? null,
        changes: (h.details?.changes ?? []).map((c) => ({ ...c, beforeLabel: c.before ? PRESENCE_LABELS[c.before] : null, afterLabel: PRESENCE_LABELS[c.after] })),
      })),
    });
  }

  /** Correção pela gestão (a qualquer momento), sempre com motivo; fica no histórico. */
  async correct(repo: PresenceRepository, actor: { id: string; canEdit: boolean }, sessionId: string, input: { reason: string; marks: MarkInput[] }): R<{ changed: number }> {
    if (!actor.canEdit) return fail(attendanceError("FORBIDDEN", "Não tem permissão para corrigir presenças."));
    const s = await repo.sessionById(sessionId);
    if (!s) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    const reason = input.reason.replace(/\s+/g, " ").trim();
    if (reason.length < 3 || reason.length > 300) return fail(attendanceError("INVALID_INPUT", "Indique o motivo da correção (3 a 300 caracteres)."));
    const before = await repo.marks(s.id);
    const checked = checkMarks(
      before.map((m) => m.studentId),
      input.marks,
    );
    if (!checked.ok) return checked;
    const changes = diff(before, checked.value, new Map(before.map((m) => [m.studentId, m.fullName])));
    if (!changes.length) return fail(attendanceError("INVALID_INPUT", "Nada mudou."));
    const now = this.clock.now();
    await repo.replaceMarks(s.id, checked.value, actor.id, now);
    await repo.record("LESSON_ATTENDANCE_CORRECTED", s.id, actor.id, { changes, reason }, now);
    return ok({ changed: changes.length });
  }
}

export type { PresenceStatus };
