import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { gradeLabel, pedagogyError, SHIFT_LABELS, YEAR_STATUS_LABELS } from "../domain/academic";
import {
  acceptAssignments,
  type ApplySkip,
  type CoordTeacher,
  checkQualification,
  gradesText,
  type OpenSlot,
  type PoolTeacher,
  proposeAssignments,
  proposeCoordinators as pickCoordinators,
  QUALIFICATION_LEVEL_KEYS,
  QUALIFICATION_LEVELS,
  type QualificationData,
  type QualificationLevel,
  qualifies,
  type SlotSkip,
} from "../domain/qualifications";
import { clashPairs, TEACHER_STATUSES, WEEKDAY_LABELS } from "../domain/teaching";
import { WEEKDAYS } from "../domain/timetable";
import type { Pedagogy } from "./Pedagogy";
import type { PedagogyActor } from "./ports";
import type { QualificationCatalog, TeacherLesson, TeachingOutcome, TeachingRepository } from "./teaching-ports";

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
    case "taken":
      return pedagogyError("INVALID_STATE", "Entretanto já foi atribuído.");
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
    const [loads, quals] = await Promise.all([repo.loads(t.year.id), repo.allQualifications()]);
    const here = new Set(t.subjects.flatMap((s) => (s.teacher ? [s.teacher.id] : [])));
    // cada candidato com as disciplinas da turma para que está habilitado, a carga e as coordenações
    const candidates = loads
      .filter((l) => (TEACHER_STATUSES as readonly string[]).includes(l.status))
      .map(({ assignments, weeklyPeriods, scheduled: _s, coordinates, ...c }) => {
        const mine = quals.filter((q) => q.employeeId === c.id);
        return {
          ...c,
          qualified: mine.length > 0,
          qualifiedSubjectIds: t.subjects.filter((s) => qualifies(mine, t.cls.grade, t.cls.courseId, s.subject.id)).map((s) => s.subject.id),
          weeklyPeriods,
          teachesHere: here.has(c.id),
          coordinates: coordinates.map((g) => g.label),
          coordinatesHere: t.group.coordinator?.id === c.id,
          free: assignments === 0 && coordinates.length === 0,
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
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
  async teachers(repo: TeachingRepository, actor: PedagogyActor, input: { yearId?: string | null }) {
    const yearId = input.yearId ?? (await repo.currentYearId());
    const year = yearId ? await repo.yearInfo(yearId) : null;
    if (input.yearId && !year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    const [loads, quals, catalog] = await Promise.all([year ? repo.loads(year.id) : [], repo.allQualifications(), repo.qualificationCatalog()]);
    const withClashes = await Promise.all(
      loads.map(async (l) => {
        const mine = quals.filter((q) => q.employeeId === l.id);
        return {
          ...l,
          clashes: l.scheduled && year ? (await this.clashesOf(repo, l.id, year.id)).clashes.length : 0,
          qualifications: mine.map((q) => qualificationSummary(q, catalog)),
          qualified: mine.length > 0,
          // livre: sem turmas atribuídas e sem coordenar nenhuma turma
          free: l.assignments === 0 && l.coordinates.length === 0,
        };
      }),
    );
    // primeiro quem dá aulas (mais carga primeiro), depois os restantes por nome
    withClashes.sort((a, b) => Number(b.assignments > 0) - Number(a.assignments > 0) || b.weeklyPeriods - a.weeklyPeriods || a.fullName.localeCompare(b.fullName));
    return ok({
      year: year ? { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] } : null,
      // atribuir/propor: a direção, num ano que não está encerrado
      canManage: this.pedagogy.canManage(actor) && !!year && year.status !== "CLOSED",
      teachers: withClashes,
    });
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

  /**
   * "As minhas turmas": as turmas do professor ligado a esta conta (onde dá aulas ou que
   * coordena), as disciplinas que dá em cada uma e, por disciplina, em que turmas a dá.
   */
  async myClasses(repo: TeachingRepository, userId: string, input: { yearId?: string | null }) {
    const me = await repo.employeeOfUser(userId);
    if (!me) return fail(pedagogyError("TEACHER_NOT_FOUND", "Esta conta não está ligada a nenhum professor."));
    const yearId = input.yearId ?? (await repo.currentYearId());
    const year = yearId ? await repo.yearInfo(yearId) : null;
    const [groups, quals, catalog] = await Promise.all([year ? repo.teacherGroups(me.id, year.id) : [], repo.qualifications(me.id), repo.qualificationCatalog()]);
    const bySubject = new Map<string, { subject: { id: string; name: string; code: string; color: string }; groups: { id: string; label: string; weeklyPeriods: number; scheduled: number }[] }>();
    for (const g of groups) {
      for (const s of g.subjects) {
        const entry = bySubject.get(s.subject.id) ?? { subject: s.subject, groups: [] };
        entry.groups.push({ id: g.id, label: g.label, weeklyPeriods: s.weeklyPeriods, scheduled: s.scheduled });
        bySubject.set(s.subject.id, entry);
      }
    }
    const subjects = [...bySubject.values()]
      .map((s) => ({ ...s, weeklyPeriods: s.groups.reduce((n, g) => n + g.weeklyPeriods, 0), scheduled: s.groups.reduce((n, g) => n + g.scheduled, 0) }))
      .sort((a, b) => a.subject.name.localeCompare(b.subject.name));
    return ok({
      teacher: me,
      year: year ? { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] } : null,
      groups: groups.map((g) => ({ ...g, gradeLabel: gradeLabel(g.grade), shiftLabel: SHIFT_LABELS[g.shift] })),
      subjects,
      qualifications: quals.map((q) => qualificationSummary(q, catalog)),
      totals: {
        groups: groups.length,
        subjects: subjects.length,
        weeklyPeriods: subjects.reduce((n, s) => n + s.weeklyPeriods, 0),
        coordinates: groups.filter((g) => g.isCoordinator).length,
      },
    });
  }

  /** O professor só abre as turmas onde dá aulas ou que coordena (as outras: "não encontrada"). */
  async myGroupAccess(repo: TeachingRepository, userId: string, groupId: string) {
    const me = await repo.employeeOfUser(userId);
    if (!me) return fail(pedagogyError("TEACHER_NOT_FOUND", "Esta conta não está ligada a nenhum professor."));
    const access = await repo.groupAccess(me.id, groupId);
    if (!access) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    return ok({ employeeId: me.id, ...access });
  }

  // ================================================================ habilitações

  /** As habilitações do professor e o catálogo para as escolher (tipos de ensino, classes, cursos, disciplinas). */
  async qualifications(repo: TeachingRepository, actor: PedagogyActor, employeeId: string) {
    const teacher = await repo.findTeacher(employeeId);
    if (!teacher) return fail(pedagogyError("TEACHER_NOT_FOUND", "Professor não encontrado."));
    const [quals, catalog] = await Promise.all([repo.qualifications(employeeId), repo.qualificationCatalog()]);
    const course = new Map(catalog.courses.map((c) => [c.id, c]));
    const subject = new Map(catalog.subjects.map((s) => [s.id, s]));
    return ok({
      teacher,
      canManage: this.pedagogy.canManage(actor),
      qualifications: quals.map((q) => ({
        ...q,
        levelLabel: QUALIFICATION_LEVELS[q.level].label,
        gradesText: gradesText(q.grades),
        courses: q.courseIds.flatMap((id) => (course.has(id) ? [course.get(id)!] : [])),
        subjects: q.subjectIds.flatMap((id) => (subject.has(id) ? [subject.get(id)!] : [])),
        summary: qualificationSummary(q, catalog),
      })),
      catalog: {
        levels: QUALIFICATION_LEVEL_KEYS.map((key) => ({
          key,
          label: QUALIFICATION_LEVELS[key].label,
          byCourse: QUALIFICATION_LEVELS[key].byCourse,
          grades: QUALIFICATION_LEVELS[key].grades.map((grade) => ({ grade, label: gradeLabel(grade) })),
        })),
        courses: catalog.courses.filter((c) => !c.archived),
        subjects: catalog.subjects.filter((s) => !s.archived),
      },
    });
  }

  /** Cria (sem id) ou altera uma habilitação. */
  async saveQualification(
    repo: TeachingRepository,
    actor: PedagogyActor,
    employeeId: string,
    input: { level: string; grades: number[]; courseIds?: string[]; subjectIds: string[] },
    id?: string,
  ) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    if (!(await repo.findTeacher(employeeId))) return fail(pedagogyError("TEACHER_NOT_FOUND", "Professor não encontrado."));
    const catalog = await repo.qualificationCatalog();
    const data = checkQualification(input, {
      courseIds: new Set(catalog.courses.filter((c) => !c.archived).map((c) => c.id)),
      subjectIds: new Set(catalog.subjects.filter((s) => !s.archived).map((s) => s.id)),
    });
    if (!data.ok) return data;
    const saved = await repo.saveQualification({ id, employeeId, data: data.value, now: this.clock.now() });
    if (!saved) return fail(pedagogyError("QUALIFICATION_NOT_FOUND", "Habilitação não encontrada."));
    return ok({ id: saved, summary: qualificationSummary(data.value, catalog) });
  }

  async removeQualification(repo: TeachingRepository, actor: PedagogyActor, employeeId: string, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    if (!(await repo.deleteQualification(employeeId, id))) return fail(pedagogyError("QUALIFICATION_NOT_FOUND", "Habilitação não encontrada."));
    return ok({ removed: true });
  }

  // ================================================================ propostas automáticas

  /** O ano (aberto) e o estado de agora: turmas, professores elegíveis e habilitações. */
  private async snapshot(repo: TeachingRepository, actor: PedagogyActor, yearId: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.yearInfo(yearId);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const [plan, loads, quals, catalog] = await Promise.all([repo.yearPlan(yearId), repo.loads(yearId), repo.allQualifications(), repo.qualificationCatalog()]);
    const teachers = loads.filter((l) => (TEACHER_STATUSES as readonly string[]).includes(l.status));
    const qualsOf = (id: string) => quals.filter((q) => q.employeeId === id);
    const pool: PoolTeacher[] = teachers.map((t) => ({
      id: t.id,
      quals: qualsOf(t.id),
      busy: plan.flatMap((g) => g.lessons.filter((l) => l.teacherId === t.id).map((l) => ({ weekday: l.weekday, startsAt: l.startsAt, endsAt: l.endsAt, groupId: g.id }))),
      load: t.weeklyPeriods,
      groups: new Set(plan.filter((g) => g.subjects.some((s) => s.teacherId === t.id)).map((g) => g.id)),
    }));
    const slots: OpenSlot[] = plan.flatMap((g) =>
      g.subjects
        .filter((s) => !s.teacherId)
        .map((s) => ({
          groupId: g.id,
          subjectId: s.subjectId,
          grade: g.grade,
          courseId: g.courseId,
          weeklyPeriods: s.weeklyPeriods,
          lessons: g.lessons.filter((l) => l.subjectId === s.subjectId).map(({ weekday, startsAt, endsAt }) => ({ weekday, startsAt, endsAt })),
        })),
    );
    // para coordenar: quem é professor (tem habilitações ou turmas), não qualquer funcionário
    const coordPool: CoordTeacher[] = teachers
      .filter((t) => t.assignments > 0 || qualsOf(t.id).length > 0)
      .map((t) => ({
        id: t.id,
        coordinating: t.coordinates.length,
        load: t.weeklyPeriods,
        periodsIn: new Map(plan.map((g) => [g.id, g.subjects.filter((s) => s.teacherId === t.id).reduce((n, s) => n + s.weeklyPeriods, 0)])),
      }));
    const name = new Map(teachers.map((t) => [t.id, t.fullName]));
    const group = new Map(plan.map((g) => [g.id, g]));
    const subject = new Map(catalog.subjects.map((s) => [s.id, { id: s.id, name: s.name, code: s.code, color: s.color }]));
    return ok({ year, plan, pool, slots, coordPool, name, group, subject, nameOf: (id: string) => name.get(id) ?? "" });
  }

  /** Proposta: um professor habilitado e livre para cada disciplina sem professor. Não grava nada. */
  async proposeTeachers(repo: TeachingRepository, actor: PedagogyActor, yearId: string) {
    const s = await this.snapshot(repo, actor, yearId);
    if (!s.ok) return s;
    const { slots, pool, nameOf, group, subject, year } = s.value;
    const { assignments, skipped } = proposeAssignments(slots, pool, nameOf);
    const weekly = new Map(slots.map((x) => [`${x.groupId}:${x.subjectId}`, x.weeklyPeriods]));
    const row = (x: { groupId: string; subjectId: string }) => ({
      groupId: x.groupId,
      groupLabel: group.get(x.groupId)!.label,
      subjectId: x.subjectId,
      subject: subject.get(x.subjectId)!,
      weeklyPeriods: weekly.get(`${x.groupId}:${x.subjectId}`) ?? 0,
    });
    const order = (a: { groupLabel: string; subject: { name: string } }, b: typeof a) => a.groupLabel.localeCompare(b.groupLabel) || a.subject.name.localeCompare(b.subject.name);
    return ok({
      year: { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] },
      open: slots.length,
      qualifiedTeachers: pool.filter((t) => t.quals.length).length,
      assignments: assignments.map((a) => ({ ...row(a), employeeId: a.employeeId, teacher: nameOf(a.employeeId) })).sort(order),
      skipped: skipped.map((x) => ({ ...row(x), reason: x.reason, reasonLabel: SLOT_SKIP_LABELS[x.reason] })).sort(order),
    });
  }

  /** Aplica a proposta vista: confirma cada atribuição contra o estado de agora e grava as que ainda servem. */
  async applyTeachers(repo: TeachingRepository, actor: PedagogyActor, yearId: string, requested: { groupId: string; subjectId: string; employeeId: string }[]) {
    const s = await this.snapshot(repo, actor, yearId);
    if (!s.ok) return s;
    const { slots, pool, nameOf, group, subject } = s.value;
    const { accepted, skipped } = acceptAssignments(slots, pool, requested);
    const applied: typeof accepted = [];
    for (const a of accepted) {
      const r = await repo.assign({ ...a, actorId: actor.support ? null : actor.id, now: this.clock.now(), onlyIfEmpty: true });
      if (r.ok) applied.push(a);
      else skipped.push({ ...a, reason: r.reason === "teacher_invalid" ? "not_found" : "taken" });
    }
    return ok({
      applied: applied.length,
      skipped: skipped.map((x) => ({
        ...x,
        groupLabel: group.get(x.groupId)?.label ?? "",
        subject: subject.get(x.subjectId) ?? null,
        teacher: nameOf(x.employeeId),
        reasonLabel: APPLY_SKIP_LABELS[x.reason],
      })),
    });
  }

  /** Proposta: um coordenador livre (não coordena nenhuma turma) para cada turma sem coordenador. */
  async proposeCoordinators(repo: TeachingRepository, actor: PedagogyActor, yearId: string) {
    const s = await this.snapshot(repo, actor, yearId);
    if (!s.ok) return s;
    const { plan, coordPool, nameOf, year } = s.value;
    const open = plan.filter((g) => !g.coordinatorId);
    const { picks, skipped } = pickCoordinators(
      open.map((g) => g.id),
      coordPool,
      nameOf,
    );
    const label = new Map(plan.map((g) => [g.id, g.label]));
    const periods = new Map(coordPool.map((t) => [t.id, t.periodsIn]));
    const order = (a: { groupLabel: string }, b: { groupLabel: string }) => a.groupLabel.localeCompare(b.groupLabel);
    return ok({
      year: { ...year, statusLabel: YEAR_STATUS_LABELS[year.status] },
      open: open.length,
      freeTeachers: coordPool.filter((t) => t.coordinating === 0).length,
      picks: picks
        .map((p) => ({ ...p, groupLabel: label.get(p.groupId)!, teacher: nameOf(p.employeeId), periodsHere: periods.get(p.employeeId)?.get(p.groupId) ?? 0 }))
        .sort(order),
      skipped: skipped.map((g) => ({ groupId: g, groupLabel: label.get(g)!, reasonLabel: "Não há professores livres (todos já coordenam uma turma)." })).sort(order),
    });
  }

  async applyCoordinators(repo: TeachingRepository, actor: PedagogyActor, yearId: string, requested: { groupId: string; employeeId: string }[]) {
    const s = await this.snapshot(repo, actor, yearId);
    if (!s.ok) return s;
    const { plan, coordPool, nameOf } = s.value;
    const label = new Map(plan.map((g) => [g.id, g.label]));
    const used = new Set<string>();
    let applied = 0;
    const skipped: { groupId: string; employeeId: string; groupLabel: string; teacher: string; reasonLabel: string }[] = [];
    const skip = (r: (typeof requested)[number], reasonLabel: string) => skipped.push({ ...r, groupLabel: label.get(r.groupId) ?? "", teacher: nameOf(r.employeeId), reasonLabel });
    for (const r of requested) {
      const g = plan.find((x) => x.id === r.groupId);
      const t = coordPool.find((x) => x.id === r.employeeId);
      if (!g || g.coordinatorId) {
        skip(r, APPLY_SKIP_LABELS.taken);
        continue;
      }
      if (!t || t.coordinating > 0 || used.has(t.id)) {
        skip(r, "Este professor já coordena outra turma ou deixou de estar disponível.");
        continue;
      }
      const out = await repo.setCoordinator(r.groupId, r.employeeId, this.clock.now(), true);
      if (!out.ok) {
        skip(r, out.reason === "teacher_invalid" ? APPLY_SKIP_LABELS.not_found : APPLY_SKIP_LABELS.taken);
        continue;
      }
      used.add(t.id);
      applied++;
    }
    return ok({ applied, skipped });
  }
}

const SLOT_SKIP_LABELS: Record<SlotSkip, string> = {
  no_qualified: "Nenhum professor está habilitado para esta disciplina nesta classe.",
  all_busy: "Os professores habilitados estão ocupados às horas destas aulas.",
};

const APPLY_SKIP_LABELS: Record<ApplySkip, string> = {
  taken: "Entretanto já foi atribuído.",
  not_qualified: "O professor já não está habilitado.",
  busy: "O professor já tem aulas a essas horas.",
  not_found: "O professor deixou de estar disponível.",
};

const LEVEL_SHORT: Record<QualificationLevel, string> = { pre: "Pré-escolar", primario: "Primário", ciclo1: "I Ciclo", ciclo2: "II Ciclo" };

/** "II Ciclo · 10.ª–12.ª · CFB, CEJ · MAT, FIS" */
function qualificationSummary(q: QualificationData, catalog: QualificationCatalog) {
  const courses = q.courseIds.map((id) => catalog.courses.find((c) => c.id === id)).flatMap((c) => (c ? [c.code ?? c.name] : []));
  const subjects = q.subjectIds.map((id) => catalog.subjects.find((s) => s.id === id)).flatMap((s) => (s ? [s.code] : []));
  return [LEVEL_SHORT[q.level], gradesText(q.grades), courses.join(", "), subjects.join(", ")].filter(Boolean).join(" · ");
}
