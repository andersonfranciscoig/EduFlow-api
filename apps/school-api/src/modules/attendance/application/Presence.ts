import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { isDay } from "../domain/occurrences";
import { checkMarks, lessonState, localNow, type Mark, type MarkInput, PRESENCE_LABELS, type PresenceStatus, rate, STATE_LABELS } from "../domain/presence";
import { type AttendanceError, attendanceError, type AttendanceRules } from "../domain/settings";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
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
  lessonNumber: s.lessonNumber,
  summary: s.summary,
  summaryUpdatedAt: s.summaryUpdatedAt?.toISOString() ?? null,
});
/** O sumário: texto limpo (espaços), até 2000 caracteres; vazio = sem sumário. */
const cleanSummary = (v: string | null | undefined) => (v ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() || null;
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
    const [planned, coordinates] = await Promise.all([year && !closure ? repo.teacherLessons(t.value.id, year.id, d) : [], repo.coordinatedGroups(t.value.id)]);
    // provas com interrupção: as aulas dessas turmas não contam (as que já têm presenças ficam)
    const breaks = await repo.examBreak([...new Set(planned.map((l) => l.groupId))], d);
    const lessons = planned.filter((l) => l.session || !breaks.some((b) => b.groupId === l.groupId));
    return ok({
      teacher: t.value,
      today,
      day: d,
      year,
      closure,
      /** turmas com as aulas suspensas neste dia por uma época de provas */
      suspended: breaks.map((b) => ({ groupName: b.groupName, reason: b.name, until: b.endsOn })),
      deadlineMinutes: rules.deadlineMinutes,
      /** turmas que coordena (abre a coordenação) */
      coordinates: coordinates.map((g) => ({ id: g.id, name: g.name })),
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
          substitutionFor: l.substitutionFor,
        };
      }),
    });
  }

  /** A aula de um dia: valida que é do professor, nesse dia da semana, num dia de aulas. */
  private async ownLesson(repo: PresenceRepository, rules: AttendanceRules, teacherId: string, lessonId: string, day: string) {
    if (!isDay(day)) return fail(attendanceError("INVALID_INPUT", "Data inválida."));
    const l = await repo.lesson(lessonId);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    if (!l || l.weekday !== weekday) return fail(attendanceError("NOT_FOUND", "Aula não encontrada no seu horário nesse dia."));
    // numa substituição, a aula desse dia é do substituto (e deixa de ser do titular)
    const substitute = await repo.substituteOn(l.id, day);
    if ((substitute ?? l.teacherId) !== teacherId) return fail(attendanceError("NOT_FOUND", "Aula não encontrada no seu horário nesse dia."));
    const year = await repo.yearOn(day);
    if (!year || year.id !== l.yearId) return fail(attendanceError("NOT_FOUND", "Esse dia não pertence ao ano letivo desta aula."));
    const closure = await repo.closureOn(year.id, day);
    if (closure) return fail(attendanceError("NO_CLASSES", `${closure.kindLabel}: ${closure.reason}. Não há aulas.`));
    const now = localNow(rules.timeZone, this.clock.now());
    const existing = await repo.sessionAt(l.groupId, day, l.startsAt);
    const [suspended] = existing ? [] : await repo.examBreak([l.groupId], day);
    if (suspended) return fail(attendanceError("NO_CLASSES", `Aulas suspensas na turma ${l.groupName}: ${suspended.name}.`));
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

  async submit(
    repo: PresenceRepository,
    rules: AttendanceRules,
    actor: { userId: string },
    lessonId: string,
    day: string,
    input: MarkInput[],
    /** o sumário (undefined = não mexer) */
    summaryInput?: string | null,
  ): R<{ sessionId: string; late: boolean; counts: ReturnType<typeof sessionDto>["counts"] }> {
    const summary = summaryInput === undefined ? undefined : cleanSummary(summaryInput);
    if (summary && summary.length > 2000) return fail(attendanceError("INVALID_INPUT", "O sumário tem no máximo 2000 caracteres."));
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
    if (!existing) {
      await repo.record("LESSON_ATTENDANCE_SUBMITTED", id, actor.userId, { late, total: checked.value.length }, now);
      if (late) await repo.resolvePending(l.groupId, day, l.startsAt, now);
    } else if (changes.length) await repo.record("LESSON_ATTENDANCE_UPDATED", id, actor.userId, { changes, reason: null }, now);
    if (summary !== undefined && summary !== (existing?.summary ?? null)) {
      await repo.setSummary(id, summary, actor.userId, now);
      await repo.record("LESSON_ATTENDANCE_SUMMARY", id, actor.userId, { before: existing?.summary ?? null, after: summary }, now);
    }
    const s = await repo.sessionById(id);
    return ok({ sessionId: id, late, counts: s?.counts ?? { present: 0, absent: 0, late: 0, justified: 0, total: 0 } });
  }

  /**
   * O sumário de uma aula já registada: o professor dessa aula escreve-o ou corrige-o a qualquer
   * momento (não depende do prazo das presenças). Cada alteração fica no histórico da aula.
   */
  async setMySummary(repo: PresenceRepository, userId: string, sessionId: string, input: string | null): R<{ summary: string | null; lessonNumber: number }> {
    const summary = cleanSummary(input);
    if (summary && summary.length > 2000) return fail(attendanceError("INVALID_INPUT", "O sumário tem no máximo 2000 caracteres."));
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const s = await repo.sessionById(sessionId);
    if (!s || s.teacherId !== t.value.id) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    if (summary !== s.summary) {
      const now = this.clock.now();
      await repo.setSummary(s.id, summary, userId, now);
      await repo.record("LESSON_ATTENDANCE_SUMMARY", s.id, userId, { before: s.summary, after: summary }, now);
    }
    return ok({ summary, lessonNumber: s.lessonNumber });
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

  /**
   * A assiduidade de uma turma (gestão e coordenador): totais, todas as aulas (com o sumário),
   * cada aluno (faltas seguidas atuais e alertas pelas regras), cada disciplina/professor e as
   * aulas que ficaram sem presenças no prazo.
   */
  private async insights(repo: PresenceRepository, rules: AttendanceRules, g: GroupRow) {
    const [sessions, students, marks, subjects, pendings] = await Promise.all([repo.groupSessions(g.id), repo.groupStudents(g.id), repo.groupMarks(g.id), repo.groupSubjects(g.id), repo.groupPendings(g.id)]);
    const total = sessions.reduce((a, s) => ({ present: a.present + s.counts.present, absent: a.absent + s.counts.absent, late: a.late + s.counts.late, justified: a.justified + s.counts.justified, total: a.total + s.counts.total }), { present: 0, absent: 0, late: 0, justified: 0, total: 0 });
    // faltas seguidas: as faltas (não justificadas) desde a última aula em que o aluno esteve
    const streak = new Map<string, number>();
    const closed = new Set<string>();
    for (const m of marks) {
      if (closed.has(m.student_id)) continue;
      if (m.status === "AUSENTE") streak.set(m.student_id, (streak.get(m.student_id) ?? 0) + 1);
      else if (m.status !== "FALTA_JUSTIFICADA") closed.add(m.student_id);
    }
    const studentRows = students.map((s) => {
      const st = streak.get(s.id) ?? 0;
      const alerts = [
        ...(s.counts.absent >= rules.absenceLimit ? [`${s.counts.absent} faltas (limite ${rules.absenceLimit})`] : []),
        ...(st >= rules.consecutiveLimit ? [`${st} faltas seguidas`] : []),
      ];
      return { ...s, rate: rate(s.counts), streak: st, alerts };
    });
    return {
      group: groupDto(g),
      rules: { absenceLimit: rules.absenceLimit, consecutiveLimit: rules.consecutiveLimit },
      totals: { ...total, rate: rate(total) },
      sessions: sessions.map(sessionDto),
      students: studentRows,
      atRisk: studentRows.filter((s) => s.alerts.length).map((s) => ({ id: s.id, fullName: s.fullName, alerts: s.alerts, rate: s.rate })),
      subjects: subjects.map((x) => ({ subjectName: x.subject_name, color: x.color, teacherName: x.teacher_name, weekly: x.weekly, sessions: x.sessions, withoutSummary: x.no_summary, late: x.late, lastDay: x.last_day })),
      pendings: pendings.map((p) => ({ id: p.id, day: p.day, startsAt: p.starts_at, subjectName: p.subject_name, teacherName: p.teacher_name, status: p.status, statusLabel: { OPEN: "Por decidir (RH)", SUBMITTED_LATE: "Registadas fora do prazo", FAULT: "Falta registada", DISMISSED: "Dispensada" }[p.status] ?? p.status })),
    };
  }

  async group(repo: PresenceRepository, rules: AttendanceRules, groupId: string) {
    const g = await repo.group(groupId);
    if (!g) return fail(attendanceError("NOT_FOUND", "Turma não encontrada."));
    return ok(await this.insights(repo, rules, g));
  }

  // ============================================================ coordenador de turma (professor)

  /** As turmas que o professor coordena. */
  async coordination(repo: PresenceRepository, userId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    return ok({ teacher: t.value, groups: (await repo.coordinatedGroups(t.value.id)).map(groupDto) });
  }

  /** A assiduidade da turma que coordena (todas as disciplinas e professores). */
  async coordinatedGroup(repo: PresenceRepository, rules: AttendanceRules, userId: string, groupId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const g = (await repo.coordinatedGroups(t.value.id)).find((x) => x.id === groupId);
    if (!g) return fail(attendanceError("NOT_FOUND", "Turma não encontrada nas turmas que coordena."));
    return ok(await this.insights(repo, rules, g));
  }

  /** Uma aula da turma que coordena (de qualquer professor): presenças e sumário, só de leitura. */
  async coordinatedSession(repo: PresenceRepository, userId: string, sessionId: string) {
    const t = await this.teacher(repo, userId);
    if (!t.ok) return t;
    const s = await repo.sessionById(sessionId);
    if (!s || !(await repo.coordinatedGroups(t.value.id)).some((g) => g.id === s.groupId)) return fail(attendanceError("NOT_FOUND", "Aula não encontrada."));
    return ok({ session: sessionDto(s), marks: (await repo.marks(s.id)).map(markDto) });
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
        actionLabel: { SUBMITTED: "Presenças submetidas", UPDATED: "Alteradas pelo professor", CORRECTED: "Corrigidas", SUMMARY: "Sumário escrito pelo professor" }[h.type.replace("LESSON_ATTENDANCE_", "")] ?? h.type,
        by: h.actorName,
        reason: h.details?.reason ?? null,
        changes: (h.details?.changes ?? []).map((c) => ({ ...c, beforeLabel: c.before ? PRESENCE_LABELS[c.before] : null, afterLabel: PRESENCE_LABELS[c.after] })),
      })),
    });
  }

  /** Correção pela gestão (a qualquer momento), sempre com motivo; fica no histórico. */
  async correct(repo: PresenceRepository, actor: { id: string; canEdit: boolean }, sessionId: string, input: { reason: string; marks: MarkInput[] }, notify?: StaffNotify): R<{ changed: number }> {
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
    // o professor da aula fica a saber o que mudou
    if (s.teacherId)
      await notify?.notify({
        kind: "ATTENDANCE_CORRECTED",
        employeeIds: [s.teacherId],
        title: `Presenças corrigidas · ${s.subjectName}, ${s.groupName}`,
        body: `${s.day.slice(8, 10)}/${s.day.slice(5, 7)} às ${s.startsAt}: ${changes.map((c) => `${c.fullName} (${c.before ? PRESENCE_LABELS[c.before] : "—"} → ${PRESENCE_LABELS[c.after]})`).join(", ")}. Motivo: ${reason}`,
        link: `/presencas/historico?turma=${s.groupId}&aula=${s.id}`,
      });
    return ok({ changed: changes.length });
  }
}

export type { PresenceStatus };
