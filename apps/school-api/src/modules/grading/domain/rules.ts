import { QUALIFICATION_LEVELS, type QualificationLevel } from "../../pedagogy/domain/qualifications";
import type { Definition } from "./model";

/**
 * QUE MODELO SE APLICA — a regra mais específica ganha:
 *   disciplina › classe › curso › ensino › todo o colégio
 * Uma regra com disciplina ganha sempre a uma sem (mesmo que esta seja da classe); no mesmo sítio,
 * a de um período ganha à do ano todo.
 */
export interface Scope {
  level: QualificationLevel | null;
  courseId: string | null;
  classId: string | null;
  subjectId: string | null;
  period: number | null;
}
export interface Rule extends Scope {
  id: string;
  modelId: string;
}
export interface RuleClass {
  id: string;
  grade: number;
  courseId: string | null;
}

export const levelOf = (grade: number): QualificationLevel => (Object.keys(QUALIFICATION_LEVELS) as QualificationLevel[]).find((k) => (QUALIFICATION_LEVELS[k].grades as readonly number[]).includes(grade)) ?? "ciclo2";

const place = (r: Scope) => (r.classId ? 3 : r.courseId ? 2 : r.level ? 1 : 0);
const rank = (r: Scope) => (r.subjectId ? 100 : 0) + place(r) * 10 + (r.period ? 1 : 0);

/** A regra que vale para uma classe, disciplina e período (period null = o ano todo). */
export function resolve(rules: Rule[], cls: RuleClass, subjectId: string | null, period: number | null): Rule | null {
  const level = levelOf(cls.grade);
  let best: Rule | null = null;
  for (const r of rules) {
    if (r.classId && r.classId !== cls.id) continue;
    if (r.courseId && r.courseId !== cls.courseId) continue;
    if (r.level && r.level !== level) continue;
    if (r.subjectId && r.subjectId !== subjectId) continue;
    if (r.period && r.period !== period) continue;
    if (!best || rank(r) > rank(best)) best = r;
  }
  return best;
}

/** De onde vem o modelo, para se perceber a herança. */
export const originOf = (r: Scope): "SUBJECT" | "CLASS" | "COURSE" | "LEVEL" | "SCHOOL" => (r.subjectId ? "SUBJECT" : r.classId ? "CLASS" : r.courseId ? "COURSE" : r.level ? "LEVEL" : "SCHOOL");

/**
 * Dois modelos só podem coexistir nos períodos da mesma disciplina se as notas se juntarem:
 * mesmo tipo (com ou sem números) e mesma escala.
 */
export const sameScale = (a: Definition, b: Definition) =>
  (a.kind === "QUALITATIVE") === (b.kind === "QUALITATIVE") && (a.kind === "QUALITATIVE" || (a.scale.min === b.scale.min && a.scale.max === b.scale.max && a.scale.pass === b.scale.pass));
