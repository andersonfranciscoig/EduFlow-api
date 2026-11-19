/**
 * ALUNOS (fase F) — a ficha do aluno na secretaria e na área da família.
 *   dados pessoais   os dados fixos do aluno (os mesmos do formulário de inscrição); só se mostram os preenchidos
 *   edição           a secretaria (com permissão) altera os dados pessoais; cada alteração fica no histórico
 *                    (campo, antes, depois, quem, quando). A família não altera dados administrativos.
 *   histórico        inscrições, matrículas e alterações, pela ordem em que aconteceram
 */
import { STUDENT_STATUS_LABELS, type StudentStatus } from "../../family/domain/family";
import { FIXED_FIELDS, type SnapshotFixedField } from "./forms";

export { STUDENT_STATUS_LABELS, type StudentStatus };
export const isStudentStatus = (s: unknown): s is StudentStatus => typeof s === "string" && s in STUDENT_STATUS_LABELS;

/** Os dados pessoais que se mostram e editam (sem a fotografia, que vem da inscrição). */
export const PERSONAL_FIELDS: SnapshotFixedField[] = FIXED_FIELDS.STUDENT.filter((f) => f.type !== "FILE").map((f) => ({ ...f, mode: f.essential ? "REQUIRED" : "OPTIONAL" }));

/** Dados guardados nas colunas do aluno (o resto fica em students.data). */
export const CORE_KEYS = ["fullName", "birthDate", "gender"] as const;

/** O que cada entrada do histórico quer dizer. */
export const ACTIVITY_LABELS: Record<string, string> = {
  APPLICATION_SUBMITTED: "Inscrição submetida",
  APPLICATION_RESUBMITTED: "Inscrição alterada e reenviada pela família",
  APPLICATION_UNDER_REVIEW: "Inscrição em análise",
  APPLICATION_CORRECTION_REQUIRED: "Correções pedidas à família",
  APPLICATION_APPROVED: "Inscrição aprovada",
  APPLICATION_REJECTED: "Inscrição rejeitada",
  STUDENT_ENROLLED: "Matriculado",
  STUDENT_UPDATED: "Dados pessoais alterados",
};

export const MAX_PAGE = 10_000;
export const PAGE_SIZE = 25;
