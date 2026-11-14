import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { gradeLabel, pedagogyError, SHIFT_LABELS, YEAR_STATUS_LABELS } from "../domain/academic";
import { clashPairs, WEEKDAY_LABELS } from "../domain/teaching";
import { WEEKDAYS } from "../domain/timetable";
import type { Pedagogy } from "./Pedagogy";
import type { PedagogyActor } from "./ports";
import type { TeacherLesson, TeachingOutcome, TeachingRepository } from "./teaching-ports";

/** "10.ª CFB · A" (curto: cabe na grelha do horário). */
const groupLabel = (l: { grade: number; courseCode: string | null; groupName: string }) => `${l.grade === 0 ? "Iniciação" : `${l.grade}.ª`}${l.courseCode ? ` ${l.courseCode}` : ""} · ${l.groupName}`;

/** "Quinta 08:50–09:35: 10.ª CFB · A (MAT) e 11.ª · B (FIS)" */
const clashText = (a: TeacherLesson, b: TeacherLesson) =>
  `${WEEKDAY_LABELS[a.weekday]} ${a.startsAt}–${a.endsAt}: ${groupLabel(a)} (${a.subject.code}) e ${groupLabel(b)} (${b.subject.code})`;

function outcomeError(r: Exclude<TeachingOutcome, { ok: true }>) {
  switch (r.reason) {
    case "not_found":
      return pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada.");
    case "closed":
      return pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura.");
    case "not_in_curriculum":
      return pedagogyError("INVALID_INPUT", "A disciplina não está no plano curricular desta classe.");
    case "teacher_invalid":
      return pedagogyError("INVALID_INPUT", "Só funcionários aprovados ou ativos podem dar aulas ou coordenar turmas.");
  }
}

/**
 * Professores: quem dá cada disciplina em cada turma, o coordenador de turma, os choques
 * (o mesmo professor em duas turmas à mesma hora) e o horário de cada professor.
 * Ver: qualquer utilizador do colégio. Atribuir: a direção.
 */
export class Teaching {
  constructor(
    private readonly clock: Clock,
    private readonly pedagogy: Pedagogy,
  ) {}

  private guard(actor: PedagogyActor) {
    return this.pedagogy.canManage(actor) ? ok(undefined) : fail(pedagogyError("FORBIDDEN", "Só a direção atribui professores e coordenadores."));
  }

  /** Choques de um professor no ano (cada um descrito numa frase). */
  private async clashesOf(repo: TeachingRepository, employeeId: string, yearId: string) {
    const lessons = await repo.teacherLessons(employeeId, yearId);
    return { lessons, clashes: clashPairs(lessons).map(([a, b]) => ({ lessonIds: [a.id, b.id], groupIds: [a.groupId, b.groupId], text: clashText(a, b) })) };
  }

  /** A turma: disciplinas do plano com o professor de cada uma, o coordenador e os choques. */
  async groupTeaching(repo: TeachingRepository, actor: PedagogyActor, groupId: string) {
    const t = await repo.groupTeaching(groupId);
    if (!t) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    const [candidates] = await Promise.all([repo.candidates()]);
    const teacherIds = [...new Set(t.subjects.flatMap((s) => (s.teacher ? [s.teacher.id] : [])))];
    const clashes = (await Promise.all(teacherIds.map((id) => this.clashesOf(repo, id, t.year.id)))).flatMap((c, i) =>
      c.clashes.filter((x) => x.groupIds.includes(groupId)).map((x) => ({ ...x, teacherId: teacherIds[i], teacher: t.subjects.find((s) => s.teacher?.id === teacherIds[i])!.teacher!.fullName })),
    );
    return ok({
      canManage: this.pedagogy.canManage(actor) && t.year.status !== "CLOSED",
      year: { ...t.year, statusLabel: YEAR_STATUS_LABELS[t.year.status] },
      cls: { ...t.cls, label: gradeLabel(t.cls.grade) },
      group: { ...t.group, shiftLabel: SHIFT_LABELS[t.group.shift] },
      subjects: t.subjects,
      candidates,
      clashes,
      assigned: t.subjects.filter((s) => s.teacher).length,
    });
  }

  /** Atribui (ou retira) o professor de uma disciplina numa turma. Grava e avisa dos choques que isso cria. */
  async assign(repo: TeachingRepository, actor: PedagogyActor, groupId: string, subjectId: string, employeeId: string | null) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const r = await repo.assign({ groupId, subjectId, employeeId, actorId: actor.support ? null : actor.id, now: this.clock.now() });
    if (!r.ok) return fail(outcomeError(r));
    const t = (await repo.groupTeaching(groupId))!;
    const warnings = employeeId ? (await this.clashesOf(repo, employeeId, t.year.id)).clashes.filter((c) => c.groupIds.includes(groupId)).map((c) => c.text) : [];
    return ok({ warnings, subject: t.subjects.find((s) => s.subject.id === subjectId) ?? null });
  }

  async setCoordinator(repo: TeachingRepository, actor: PedagogyActor, groupId: string, employeeId: string | null) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const r = await repo.setCoordinator(groupId, employeeId, this.clock.now());
    if (!r.ok) return fail(outcomeError(r));
    return ok({ coordinator: (await repo.groupTeaching(groupId))!.group.coordinator });
  }

  /** Professores do ano: carga (turmas, tempos/semana, aulas marcadas), coordenações e choques. */
  async teachers(repo: TeachingRepository, input: { yearId?: string | null }) {
    const yearId = input.yearId ?? (await repo.currentYearId());
    const year = yearId ? await repo.yearInfo(yearId) : null;
    if (input.yearId && !year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    const loads = year ? await repo.loads(year.id) : [];
    const withClashes = await Promise.all(loads.map(async (l) => ({ ...l, clashes: l.scheduled && year ? (await this.clashesOf(repo, l.id, year.id)).clashes.length : 0 })));
    // primeiro quem dá aulas (mais carga primeiro), depois os restantes por nome
    withClashes.sort((a, b) => Number(b.assignments > 0) - Number(a.assignments > 0) || b.weeklyPeriods - a.weeklyPeriods || a.fullName.localeCompare(b.fullName));
    return ok({ year: year ? { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] } : null, teachers: withClashes });
  }

  /** O horário de um professor: as suas aulas na semana (dia, hora, turma, disciplina, sala) e os choques. */
  async teacherTimetable(repo: TeachingRepository, employeeId: string, input: { yearId?: string | null }) {
    const teacher = await repo.findTeacher(employeeId);
    if (!teacher) return fail(pedagogyError("TEACHER_NOT_FOUND", "Professor não encontrado."));
    const yearId = input.yearId ?? (await repo.currentYearId());
    const year = yearId ? await repo.yearInfo(yearId) : null;
    const { lessons, clashes } = year ? await this.clashesOf(repo, employeeId, year.id) : { lessons: [] as TeacherLesson[], clashes: [] as { lessonIds: string[]; text: string }[] };
    const clashing = new Set(clashes.flatMap((c) => c.lessonIds));
    return ok({
      teacher,
      year: year ? { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] } : null,
      weekdays: WEEKDAYS,
      lessons: lessons.map((l) => ({ ...l, groupLabel: groupLabel(l), shiftLabel: SHIFT_LABELS[l.shift], clash: clashing.has(l.id) })),
      clashes: clashes.map((c) => c.text),
      totals: { lessons: lessons.length, groups: new Set(lessons.map((l) => l.groupId)).size, subjects: new Set(lessons.map((l) => l.subject.id)).size },
    });
  }

  /** "O meu horário": o do funcionário ligado a esta conta. */
  async myTimetable(repo: TeachingRepository, userId: string, input: { yearId?: string | null }) {
    const me = await repo.employeeOfUser(userId);
    if (!me) return fail(pedagogyError("TEACHER_NOT_FOUND", "Esta conta não está ligada a nenhum professor."));
    return this.teacherTimetable(repo, me.id, input);
  }
}
