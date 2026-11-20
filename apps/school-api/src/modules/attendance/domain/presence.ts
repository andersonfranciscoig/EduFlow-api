import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type AttendanceError, attendanceError } from "./settings";

/**
 * PRESENÇAS DOS ALUNOS numa aula do horário, num dia.
 *
 * Estado da aula para o professor (horas no fuso do colégio):
 *   FUTURE       ainda não começou (não se marca)
 *   IN_PROGRESS  a decorrer (já se pode marcar)
 *   OPEN         terminou, dentro do prazo (fim + prazo das regras)
 *   PENDING      passou o prazo sem presenças (o professor ainda pode submeter: fica "fora do prazo")
 *   SUBMITTED    presenças submetidas (o professor corrige até ao fim do prazo; depois só a gestão, com motivo)
 */
export type PresenceStatus = "PRESENTE" | "AUSENTE" | "ATRASADO" | "FALTA_JUSTIFICADA";
export type LessonState = "FUTURE" | "IN_PROGRESS" | "OPEN" | "PENDING" | "SUBMITTED";

export const PRESENCE_LABELS: Record<PresenceStatus, string> = { PRESENTE: "Presente", AUSENTE: "Ausente", ATRASADO: "Atrasado", FALTA_JUSTIFICADA: "Falta justificada" };
export const STATE_LABELS: Record<LessonState, string> = { FUTURE: "Ainda não começou", IN_PROGRESS: "A decorrer", OPEN: "Por marcar", PENDING: "Fora do prazo", SUBMITTED: "Presenças registadas" };
export const isPresence = (v: string): v is PresenceStatus => v in PRESENCE_LABELS;

/** "AAAA-MM-DD HH:MM" agora no fuso do colégio (comparável como texto). */
export function localNow(timeZone: string, now: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "AAAA-MM-DD" + "HH:MM" + minutos → "AAAA-MM-DD HH:MM" (pode passar para o dia seguinte). */
export function addMinutes(day: string, time: string, minutes: number) {
  const d = new Date(`${day}T${time}:00Z`);
  const r = new Date(d.getTime() + minutes * 60_000).toISOString();
  return `${r.slice(0, 10)} ${r.slice(11, 16)}`;
}

export function lessonState(day: string, startsAt: string, endsAt: string, deadlineMinutes: number, now: string, submitted: boolean) {
  const start = `${day} ${startsAt}`;
  const end = `${day} ${endsAt}`;
  const deadline = addMinutes(day, endsAt, deadlineMinutes);
  const state: LessonState = submitted ? "SUBMITTED" : now < start ? "FUTURE" : now < end ? "IN_PROGRESS" : now < deadline ? "OPEN" : "PENDING";
  return { state, deadline, beforeDeadline: now < deadline, started: now >= start };
}

export interface MarkInput {
  studentId: string;
  status: string;
  minutesLate?: number | null;
  note?: string | null;
}
export interface Mark {
  studentId: string;
  status: PresenceStatus;
  minutesLate: number | null;
  note: string | null;
}

/** Todos os alunos da turma, cada um uma vez, com um estado válido. */
export function checkMarks(roster: string[], input: MarkInput[]): Result<Mark[], AttendanceError> {
  const set = new Set(roster);
  const seen = new Set<string>();
  const out: Mark[] = [];
  for (const m of input) {
    if (!set.has(m.studentId)) return fail(attendanceError("INVALID_INPUT", "Há um aluno que não pertence a esta turma."));
    if (seen.has(m.studentId)) return fail(attendanceError("INVALID_INPUT", "Um aluno foi marcado duas vezes."));
    seen.add(m.studentId);
    if (!isPresence(m.status)) return fail(attendanceError("INVALID_INPUT", "Estado de presença inválido."));
    const late = m.status === "ATRASADO" && m.minutesLate ? m.minutesLate : null;
    if (late !== null && (!Number.isInteger(late) || late < 1 || late > 300)) return fail(attendanceError("INVALID_INPUT", "Minutos de atraso entre 1 e 300."));
    const note = (m.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
    out.push({ studentId: m.studentId, status: m.status, minutesLate: late, note });
  }
  const missing = roster.length - seen.size;
  if (missing > 0) return fail(attendanceError("INVALID_INPUT", `Falta marcar ${missing} aluno${missing === 1 ? "" : "s"}.`, { missing }));
  return ok(out);
}

export function counts(marks: { status: PresenceStatus }[]) {
  const c = { PRESENTE: 0, AUSENTE: 0, ATRASADO: 0, FALTA_JUSTIFICADA: 0 };
  for (const m of marks) c[m.status]++;
  return { present: c.PRESENTE, absent: c.AUSENTE, late: c.ATRASADO, justified: c.FALTA_JUSTIFICADA, total: marks.length };
}

/** Percentagem de presença (presentes + atrasados) — sem aulas, null. */
export const rate = (c: { present: number; late: number; total: number }) => (c.total ? Math.round(((c.present + c.late) / c.total) * 1000) / 10 : null);
