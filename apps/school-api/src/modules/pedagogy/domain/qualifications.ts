/**
 * HABILITAÇÕES — o que cada professor pode lecionar, e as propostas automáticas.
 *   habilitação   tipo de ensino → classes (e cursos, no II Ciclo) → disciplinas
 *                 (as disciplinas valem para todas as classes/cursos escolhidos)
 *   habilitado    o professor tem uma habilitação com a classe, o curso (se houver) e a disciplina
 *   atribuir      para cada disciplina de cada turma sem professor: um habilitado que esteja
 *                 livre às horas das aulas já marcadas, com a menor carga
 *   coordenador   para cada turma sem coordenador: um professor que não coordene nenhuma turma,
 *                 primeiro quem já dá aulas na turma, senão o de menor carga
 */
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type PedagogyError, pedagogyError } from "./academic";
import { overlaps } from "./teaching";

export const QUALIFICATION_LEVELS = {
  pre: { label: "Pré-escolar", grades: [0], byCourse: false },
  primario: { label: "Ensino Primário", grades: [1, 2, 3, 4, 5, 6], byCourse: false },
  ciclo1: { label: "I Ciclo do Ensino Secundário", grades: [7, 8, 9], byCourse: false },
  ciclo2: { label: "II Ciclo do Ensino Secundário", grades: [10, 11, 12, 13], byCourse: true },
} as const;
export type QualificationLevel = keyof typeof QUALIFICATION_LEVELS;
export const QUALIFICATION_LEVEL_KEYS = Object.keys(QUALIFICATION_LEVELS) as QualificationLevel[];
export const MAX_QUALIFICATION_SUBJECTS = 60;

export interface QualificationData {
  level: QualificationLevel;
  grades: number[];
  courseIds: string[];
  subjectIds: string[];
}

export interface Qualification extends QualificationData {
  id: string;
}

/** Valida uma habilitação contra o catálogo (cursos e disciplinas não arquivados). */
export function checkQualification(
  input: { level: string; grades: number[]; courseIds?: string[]; subjectIds: string[] },
  catalog: { courseIds: Set<string>; subjectIds: Set<string> },
): Result<QualificationData, PedagogyError> {
  const level = QUALIFICATION_LEVELS[input.level as QualificationLevel];
  if (!level) return fail(pedagogyError("INVALID_INPUT", "Escolha o tipo de ensino."));
  const grades = [...new Set(input.grades)].sort((a, b) => a - b);
  if (!grades.length) return fail(pedagogyError("INVALID_INPUT", "Escolha pelo menos uma classe."));
  if (grades.some((g) => !(level.grades as readonly number[]).includes(g)))
    return fail(pedagogyError("INVALID_INPUT", `As classes têm de ser do ${level.label}.`));
  const courseIds = [...new Set(input.courseIds ?? [])];
  if (level.byCourse && !courseIds.length) return fail(pedagogyError("INVALID_INPUT", "No II Ciclo, escolha pelo menos um curso."));
  if (!level.byCourse && courseIds.length) return fail(pedagogyError("INVALID_INPUT", "Só o II Ciclo tem cursos."));
  if (courseIds.some((c) => !catalog.courseIds.has(c))) return fail(pedagogyError("COURSE_NOT_FOUND", "Um dos cursos não existe ou está arquivado."));
  const subjectIds = [...new Set(input.subjectIds)];
  if (!subjectIds.length) return fail(pedagogyError("INVALID_INPUT", "Escolha pelo menos uma disciplina."));
  if (subjectIds.length > MAX_QUALIFICATION_SUBJECTS) return fail(pedagogyError("INVALID_INPUT", `No máximo ${MAX_QUALIFICATION_SUBJECTS} disciplinas por habilitação.`));
  if (subjectIds.some((s) => !catalog.subjectIds.has(s))) return fail(pedagogyError("SUBJECT_NOT_FOUND", "Uma das disciplinas não existe ou está arquivada."));
  return ok({ level: input.level as QualificationLevel, grades, courseIds, subjectIds });
}

/** O professor está habilitado para esta disciplina nesta classe (e curso)? */
export const qualifies = (quals: QualificationData[], grade: number, courseId: string | null, subjectId: string) =>
  quals.some((q) => q.grades.includes(grade) && (!q.courseIds.length || (!!courseId && q.courseIds.includes(courseId))) && q.subjectIds.includes(subjectId));

/** "7.ª–9.ª", "1.ª, 3.ª e 5.ª", "Iniciação" */
export function gradesText(grades: number[]) {
  const name = (g: number) => (g === 0 ? "Iniciação" : `${g}.ª`);
  const sorted = [...grades].sort((a, b) => a - b);
  const contiguous = sorted.every((g, i) => i === 0 || g === sorted[i - 1] + 1);
  if (sorted.length > 2 && contiguous) return `${name(sorted[0])}–${name(sorted[sorted.length - 1])}`;
  const names = sorted.map(name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : (names[0] ?? "");
}

// ================================================================ atribuição automática

export interface Timed {
  weekday: number;
  startsAt: string;
  endsAt: string;
}

/** Uma disciplina de uma turma sem professor. */
export interface OpenSlot {
  groupId: string;
  subjectId: string;
  grade: number;
  courseId: string | null;
  weeklyPeriods: number;
  /** as aulas já marcadas no horário desta disciplina nesta turma */
  lessons: Timed[];
}

export interface PoolTeacher {
  id: string;
  quals: QualificationData[];
  /** as aulas que já dá (todas as turmas do ano) */
  busy: (Timed & { groupId: string })[];
  /** tempos por semana já atribuídos */
  load: number;
  /** turmas onde já dá aulas */
  groups: Set<string>;
}

export type SlotSkip = "no_qualified" | "all_busy";
export type ApplySkip = "taken" | "not_qualified" | "busy" | "not_found";

const clashes = (t: PoolTeacher, slot: OpenSlot) => slot.lessons.some((l) => t.busy.some((b) => b.weekday === l.weekday && overlaps(b, l)));

/** Grava na pool o que a proposta já atribuiu (para as próximas escolhas). */
function take(t: PoolTeacher, slot: OpenSlot) {
  t.busy.push(...slot.lessons.map((l) => ({ ...l, groupId: slot.groupId })));
  t.load += slot.weeklyPeriods;
  t.groups.add(slot.groupId);
}

const clonePool = (pool: PoolTeacher[]) => pool.map((t) => ({ ...t, busy: [...t.busy], groups: new Set(t.groups) }));

/**
 * Proposta de atribuição: primeiro as disciplinas com menos habilitados (as mais difíceis),
 * e para cada uma o habilitado sem choque com a menor carga (desempate: já dá aulas na turma, nome).
 */
export function proposeAssignments(slots: OpenSlot[], teachers: PoolTeacher[], nameOf: (id: string) => string) {
  const pool = clonePool(teachers);
  const qualified = new Map(slots.map((s) => [s, pool.filter((t) => qualifies(t.quals, s.grade, s.courseId, s.subjectId))]));
  const order = [...slots].sort((a, b) => qualified.get(a)!.length - qualified.get(b)!.length || b.weeklyPeriods - a.weeklyPeriods);
  const assignments: { groupId: string; subjectId: string; employeeId: string }[] = [];
  const skipped: { groupId: string; subjectId: string; reason: SlotSkip }[] = [];
  for (const slot of order) {
    const options = qualified.get(slot)!;
    if (!options.length) {
      skipped.push({ groupId: slot.groupId, subjectId: slot.subjectId, reason: "no_qualified" });
      continue;
    }
    const free = options.filter((t) => !clashes(t, slot));
    if (!free.length) {
      skipped.push({ groupId: slot.groupId, subjectId: slot.subjectId, reason: "all_busy" });
      continue;
    }
    free.sort((a, b) => a.load - b.load || Number(b.groups.has(slot.groupId)) - Number(a.groups.has(slot.groupId)) || nameOf(a.id).localeCompare(nameOf(b.id)));
    take(free[0], slot);
    assignments.push({ groupId: slot.groupId, subjectId: slot.subjectId, employeeId: free[0].id });
  }
  return { assignments, skipped };
}

/** Aplicar uma proposta já vista: volta a confirmar cada atribuição contra o estado de agora. */
export function acceptAssignments(slots: OpenSlot[], teachers: PoolTeacher[], requested: { groupId: string; subjectId: string; employeeId: string }[]) {
  const pool = clonePool(teachers);
  const open = new Map(slots.map((s) => [`${s.groupId}:${s.subjectId}`, s]));
  const accepted: typeof requested = [];
  const skipped: ((typeof requested)[number] & { reason: ApplySkip })[] = [];
  for (const r of requested) {
    const slot = open.get(`${r.groupId}:${r.subjectId}`);
    const t = pool.find((p) => p.id === r.employeeId);
    const reason: ApplySkip | null = !slot ? "taken" : !t ? "not_found" : !qualifies(t.quals, slot.grade, slot.courseId, slot.subjectId) ? "not_qualified" : clashes(t, slot) ? "busy" : null;
    if (reason) {
      skipped.push({ ...r, reason });
      continue;
    }
    take(t!, slot!);
    open.delete(`${r.groupId}:${r.subjectId}`);
    accepted.push(r);
  }
  return { accepted, skipped };
}

// ================================================================ coordenadores automáticos

export interface CoordTeacher {
  id: string;
  /** turmas que já coordena */
  coordinating: number;
  /** tempos por semana já atribuídos */
  load: number;
  /** tempos por semana em cada turma */
  periodsIn: Map<string, number>;
}

/**
 * Proposta de coordenadores: só professores livres (não coordenam nenhuma turma), cada um no
 * máximo uma turma. Primeiro as turmas com menos livres a dar lá aulas; em cada uma, quem lá dá
 * mais tempos, senão o livre de menor carga.
 */
export function proposeCoordinators(groupIds: string[], teachers: CoordTeacher[], nameOf: (id: string) => string) {
  const free = teachers.filter((t) => t.coordinating === 0);
  const used = new Set<string>();
  const local = (g: string) => free.filter((t) => (t.periodsIn.get(g) ?? 0) > 0);
  const order = [...groupIds].sort((a, b) => local(a).length - local(b).length);
  const picks: { groupId: string; employeeId: string; teachesHere: boolean }[] = [];
  const skipped: string[] = [];
  for (const g of order) {
    const here = local(g)
      .filter((t) => !used.has(t.id))
      .sort((a, b) => (b.periodsIn.get(g) ?? 0) - (a.periodsIn.get(g) ?? 0) || a.load - b.load || nameOf(a.id).localeCompare(nameOf(b.id)));
    const pick =
      here[0] ??
      free.filter((t) => !used.has(t.id)).sort((a, b) => a.load - b.load || nameOf(a.id).localeCompare(nameOf(b.id)))[0];
    if (!pick) {
      skipped.push(g);
      continue;
    }
    used.add(pick.id);
    picks.push({ groupId: g, employeeId: pick.id, teachesHere: (pick.periodsIn.get(g) ?? 0) > 0 });
  }
  return { picks, skipped };
}
