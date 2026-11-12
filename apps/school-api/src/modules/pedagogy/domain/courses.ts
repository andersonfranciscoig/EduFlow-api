import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { gradeLabel, type PedagogyError, pedagogyError } from "./academic";

/**
 * CURSOS do II Ciclo — catálogo do colégio, atravessa os anos letivos.
 *   Ensino geral (GERAL)                 10.ª, 11.ª, 12.ª
 *   Técnico-profissional (TECNICO)       10.ª, 11.ª, 12.ª, 13.ª
 * Cada classe do II Ciclo pertence a um curso; o curso só aceita as classes do seu tipo.
 */
export type CourseKind = "GERAL" | "TECNICO";
export const COURSE_KINDS: CourseKind[] = ["GERAL", "TECNICO"];
export const COURSE_KIND_LABELS: Record<CourseKind, string> = { GERAL: "Ensino geral", TECNICO: "Técnico-profissional" };
export const COURSE_GRADES: Record<CourseKind, number[]> = { GERAL: [10, 11, 12], TECNICO: [10, 11, 12, 13] };

export const isCourseKind = (v: string): v is CourseKind => (COURSE_KINDS as string[]).includes(v);

/** A classe cabe no curso? (ex.: 13.ª só em cursos técnico-profissionais) */
export function checkCourseGrade(kind: CourseKind, grade: number, courseName: string): Result<void, PedagogyError> {
  if (COURSE_GRADES[kind].includes(grade)) return ok(undefined);
  return fail(
    pedagogyError(
      "INVALID_INPUT",
      `${courseName} é um curso de ${COURSE_KIND_LABELS[kind].toLowerCase()} (${COURSE_GRADES[kind].map((g) => `${g}.ª`).join(", ")}): não tem ${gradeLabel(grade)}.`,
    ),
  );
}

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || null;

export interface CourseInput {
  name: string;
  code: string | null;
  kind: CourseKind;
  description: string | null;
}

/** Nome 2–80, sigla 2–8 letras/números (maiúsculas), descrição até 300. */
export function checkCourse(input: { name: string; code?: string | null; kind: string; description?: string | null }): Result<CourseInput, PedagogyError> {
  const name = clean(input.name);
  if (!name || name.length < 2) return fail(pedagogyError("INVALID_INPUT", "Indique o nome do curso."));
  if (name.length > 80) return fail(pedagogyError("INVALID_INPUT", "O nome do curso tem no máximo 80 caracteres."));
  const code = clean(input.code)?.toUpperCase().replace(/\s/g, "") || null;
  if (code && !/^[A-Z0-9]{2,8}$/.test(code)) return fail(pedagogyError("INVALID_INPUT", "A sigla tem 2 a 8 letras ou números (ex.: CFB)."));
  if (!isCourseKind(input.kind)) return fail(pedagogyError("INVALID_INPUT", "Escolha o tipo: ensino geral ou técnico-profissional."));
  const description = clean(input.description);
  if (description && description.length > 300) return fail(pedagogyError("INVALID_INPUT", "A descrição tem no máximo 300 caracteres."));
  return ok({ name, code, kind: input.kind, description });
}

/** Sigla sugerida a partir do nome: "Ciências Físicas e Biológicas" → "CFB". */
export function suggestCode(name: string) {
  const skip = new Set(["e", "de", "da", "do", "das", "dos", "em", "a", "o"]);
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/\s+/)
    .filter((w) => w && !skip.has(w.toLowerCase()))
    .map((w) => w[0].toUpperCase())
    .join("")
    .slice(0, 8);
}
