import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * CALENDÁRIO DE PROVAS.
 *   modelo      em cada período de avaliação, quantas provas há e como se chamam (cada uma é uma ÉPOCA);
 *   época       datas, turmas e disciplinas abrangidas, com ou sem interrupção das aulas:
 *                 A. com interrupção — depois de publicada, não há aulas normais nas turmas abrangidas
 *                    entre o início e o fim da época;
 *                 B. sem interrupção — as aulas mantêm-se (a prova deve cair na aula da disciplina);
 *   prova       turma + disciplina, num dia e hora, com o professor responsável.
 *
 * Antes de guardar e de publicar verificam-se os CONFLITOS:
 *   BLOCK  não deixa guardar/publicar (a turma ou o professor em dois sítios, dia sem aulas, fora da época…)
 *   WARN   avisa e pede confirmação (prova comum a várias turmas, aula de outra disciplina, sala partilhada…)
 */
export type ExamFormat = "ESCRITA" | "ORAL" | "PRATICA" | "OUTRA";
export type SeasonStatus = "DRAFT" | "PUBLISHED";
export type ExamStatus = "SCHEDULED" | "CANCELLED";

export const FORMAT_LABELS: Record<ExamFormat, string> = { ESCRITA: "Escrita", ORAL: "Oral", PRATICA: "Prática", OUTRA: "Outra" };
export const SEASON_LABELS: Record<SeasonStatus, string> = { DRAFT: "A preparar", PUBLISHED: "Publicada" };
export const EXAM_LABELS: Record<ExamStatus, string> = { SCHEDULED: "Marcada", CANCELLED: "Cancelada" };
export const MAX_PER_PERIOD = 6;
/** Mais do que isto no mesmo dia, para uma turma, dá aviso. */
export const MAX_PER_DAY = 2;

export type ExamErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "YEAR_CLOSED" | "CONFLICTS" | "NEEDS_CONFIRMATION" | "EXAM_EXISTS" | "PROPOSAL_CHANGED";
export type ExamError = DomainError<ExamErrorCode>;
export const examError = (code: ExamErrorCode, message: string, meta?: Record<string, unknown>): ExamError => new DomainError(code, message, meta);

export const clean = (raw: string | null | undefined) => (raw ?? "").replace(/\s+/g, " ").trim();
export const cleanLong = (raw: string | null | undefined) =>
  (raw ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
const DAYS = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
export const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const dayText = (d: string) => `${DAYS[weekdayOf(d)]}, ${dmy(d)}`;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** "7.ª A", "10.ª CFB A" (um nome curto leva a classe; um nome completo fica como está). */
export const groupLabel = (g: { name: string; grade: number; courseCode: string | null }) =>
  g.name.length <= 3 ? [g.grade === 0 ? "Iniciação" : `${g.grade}.ª`, g.courseCode, g.name].filter(Boolean).join(" ") : g.name;

// ------------------------------------------------------------------ modelo e configuração

/** As provas de um período: entre 0 e 6, cada uma com um nome diferente. */
export function checkModel(items: { id?: string | null; name: string }[]): Result<{ id: string | null; name: string }[], ExamError> {
  if (items.length > MAX_PER_PERIOD) return fail(examError("INVALID_INPUT", `No máximo ${MAX_PER_PERIOD} provas por período.`));
  const seen = new Set<string>();
  const out: { id: string | null; name: string }[] = [];
  for (const it of items) {
    const name = clean(it.name);
    if (name.length < 2 || name.length > 60) return fail(examError("INVALID_INPUT", "Dê um nome a cada prova (2 a 60 caracteres)."));
    const key = name.toLocaleLowerCase("pt");
    if (seen.has(key)) return fail(examError("INVALID_INPUT", `Há duas provas com o nome "${name}".`));
    seen.add(key);
    out.push({ id: it.id ?? null, name });
  }
  return ok(out);
}

export function checkDates(year: { startsOn: string; endsOn: string }, startsOn: string, endsOn: string): Result<void, ExamError> {
  if (!isDay(startsOn) || !isDay(endsOn)) return fail(examError("INVALID_INPUT", "Indique as datas de início e de fim."));
  if (endsOn < startsOn) return fail(examError("INVALID_INPUT", "O fim tem de ser no mesmo dia ou depois do início."));
  if (startsOn < year.startsOn || endsOn > year.endsOn) return fail(examError("INVALID_INPUT", "As datas têm de ficar dentro do ano letivo."));
  if ((new Date(`${endsOn}T00:00:00Z`).getTime() - new Date(`${startsOn}T00:00:00Z`).getTime()) / 86_400_000 > 60) return fail(examError("INVALID_INPUT", "Uma época de provas dura no máximo 60 dias."));
  return ok(undefined);
}

// ------------------------------------------------------------------ conflitos

export interface SeasonCtx {
  id: string;
  name: string;
  periodPosition: number;
  position: number;
  startsOn: string | null;
  endsOn: string | null;
  interrupts: boolean;
  format: ExamFormat;
  notes: string | null;
  status: SeasonStatus;
  publishedAt: string | null;
  groupIds: string[];
  subjects: { classId: string; subjectId: string }[];
}
export interface GroupCtx {
  id: string;
  name: string;
  label: string;
  classId: string;
  grade: number;
  courseId: string | null;
  courseName: string | null;
  shift: string;
  room: string | null;
  coordinatorId: string | null;
}
export interface ExamCtx {
  id: string;
  seasonId: string;
  groupId: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  teacherId: string | null;
  teacherName: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  room: string | null;
  format: ExamFormat;
  notes: string | null;
  status: ExamStatus;
  /** AUTOMATIC = da proposta automática, ainda não ajustada à mão */
  source: "MANUAL" | "AUTOMATIC";
  cancelReason: string | null;
  updatedAt: string;
}
export interface LessonCtx {
  groupId: string;
  subjectId: string;
  subjectName: string;
  teacherId: string | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
}
/** Tudo o que conta para os conflitos de um ano letivo. */
export interface YearCtx {
  year: { id: string; name: string; startsOn: string; endsOn: string; status: string; periodKind: string };
  seasons: SeasonCtx[];
  groups: GroupCtx[];
  exams: ExamCtx[];
  lessons: LessonCtx[];
  closures: { startsOn: string; endsOn: string; reason: string }[];
  /** início e fim de cada turno (dos tempos letivos) */
  shifts: { shift: string; startsAt: string; endsAt: string }[];
}
export interface Conflict {
  level: "BLOCK" | "WARN";
  code: string;
  message: string;
}
export type Slot = Pick<ExamCtx, "seasonId" | "groupId" | "subjectId" | "subjectName" | "teacherId" | "teacherName" | "day" | "startsAt" | "endsAt" | "room" | "format"> & { id: string | null };

/** Época com interrupção que suspende as aulas desta turma neste dia (publicada, ou a que se está a preparar). */
const suspendedBy = (ctx: YearCtx, groupId: string, day: string, current: string) =>
  ctx.seasons.find((s) => s.interrupts && s.startsOn && s.endsOn && day >= s.startsOn && day <= s.endsOn && s.groupIds.includes(groupId) && (s.status === "PUBLISHED" || s.id === current));

/** Os conflitos de uma prova com o resto do ano (as outras provas, o horário, os dias sem aulas, a época). */
export function conflictsOf(ctx: YearCtx, e: Slot, today: string): Conflict[] {
  const out: Conflict[] = [];
  const block = (code: string, message: string) => out.push({ level: "BLOCK", code, message });
  const warn = (code: string, message: string) => out.push({ level: "WARN", code, message });
  const groups = new Map(ctx.groups.map((g) => [g.id, g]));
  const g = groups.get(e.groupId);
  const season = ctx.seasons.find((s) => s.id === e.seasonId);
  if (!g || !season) return [{ level: "BLOCK", code: "NOT_FOUND", message: "A turma ou a época já não existe." }];
  const label = (id: string) => groups.get(id)?.label ?? "outra turma";

  // ---- a época
  if (!season.startsOn || !season.endsOn) block("NOT_CONFIGURED", "A época ainda não tem datas.");
  else if (e.day < season.startsOn || e.day > season.endsOn) block("OUT_OF_SEASON", `${dayText(e.day)} fica fora das datas de "${season.name}" (${dmy(season.startsOn)} a ${dmy(season.endsOn)}).`);
  if (!season.groupIds.includes(e.groupId)) block("GROUP_NOT_COVERED", `A turma ${g.label} não está abrangida.`);
  else if (!season.subjects.some((s) => s.classId === g.classId && s.subjectId === e.subjectId)) block("SUBJECT_NOT_COVERED", `${e.subjectName} não está abrangida na classe da turma ${g.label}.`);

  // ---- o dia
  if (weekdayOf(e.day) === 7) block("SUNDAY", `${dmy(e.day)} é domingo.`);
  const closure = ctx.closures.find((c) => e.day >= c.startsOn && e.day <= c.endsOn);
  if (closure) block("CLOSURE", `${dayText(e.day)} não há aulas (${closure.reason}).`);
  if (e.day < today) warn("PAST", `${dayText(e.day)} já passou.`);

  // ---- as outras provas
  let sameDay = 0;
  for (const o of ctx.exams) {
    if (o.status !== "SCHEDULED" || o.id === e.id || o.day !== e.day) continue;
    if (o.groupId === e.groupId) sameDay++;
    if (!overlaps(o, e)) continue;
    const what = `${o.subjectName} (${o.startsAt}–${o.endsAt})`;
    if (o.groupId === e.groupId) {
      block("GROUP_BUSY", `A turma ${g.label} já tem a prova de ${what} a essa hora.`);
      continue;
    }
    if (e.teacherId && o.teacherId === e.teacherId) {
      const common = o.subjectId === e.subjectId && o.startsAt === e.startsAt && o.endsAt === e.endsAt;
      if (common) warn("TEACHER_COMMON", `${e.teacherName ?? "O professor"} também é responsável pela mesma prova na turma ${label(o.groupId)}, à mesma hora.`);
      else block("TEACHER_BUSY", `${e.teacherName ?? "O professor"} já é responsável pela prova de ${what} da turma ${label(o.groupId)}.`);
    }
    const room = (e.room ?? g.room ?? "").toLocaleLowerCase("pt");
    const other = (o.room ?? groups.get(o.groupId)?.room ?? "").toLocaleLowerCase("pt");
    if (room && room === other) warn("ROOM_SHARED", `A sala ${e.room ?? g.room} também está marcada para a turma ${label(o.groupId)} (${what}).`);
  }
  if (sameDay >= MAX_PER_DAY) warn("MANY_SAME_DAY", `A turma ${g.label} fica com ${sameDay + 1} provas a ${dmy(e.day)}.`);

  // ---- o horário
  const weekday = weekdayOf(e.day);
  if (!suspendedBy(ctx, e.groupId, e.day, e.seasonId))
    for (const l of ctx.lessons)
      if (l.groupId === e.groupId && l.weekday === weekday && l.subjectId !== e.subjectId && overlaps(l, e)) warn("LESSON", `Ocupa a aula de ${l.subjectName} da turma ${g.label} (${l.startsAt}–${l.endsAt}).`);
  if (e.teacherId)
    for (const l of ctx.lessons)
      if (l.teacherId === e.teacherId && l.groupId !== e.groupId && l.weekday === weekday && overlaps(l, e) && !suspendedBy(ctx, l.groupId, e.day, e.seasonId))
        warn("TEACHER_LESSON", `${e.teacherName ?? "O professor"} tem aula com a turma ${label(l.groupId)} (${l.startsAt}–${l.endsAt}).`);
  const shift = ctx.shifts.find((s) => s.shift === g.shift);
  if (shift && (e.startsAt < shift.startsAt || e.endsAt > shift.endsAt)) warn("OUT_OF_SHIFT", `Fica fora do turno da turma ${g.label} (${shift.startsAt}–${shift.endsAt}).`);
  return out;
}

/** Os dados de uma prova (sem os conflitos). */
export function checkExam(input: { day: string; startsAt: string; endsAt: string; room?: string | null; format: string; notes?: string | null }): Result<{ day: string; startsAt: string; endsAt: string; room: string | null; format: ExamFormat; notes: string | null }, ExamError> {
  if (!isDay(input.day)) return fail(examError("INVALID_INPUT", "Indique a data da prova."));
  if (!isTime(input.startsAt) || !isTime(input.endsAt)) return fail(examError("INVALID_INPUT", "Indique a hora de início e de fim."));
  const len = minutes(input.endsAt) - minutes(input.startsAt);
  if (len < 15 || len > 300) return fail(examError("INVALID_INPUT", "Uma prova dura entre 15 minutos e 5 horas."));
  if (!(input.format in FORMAT_LABELS)) return fail(examError("INVALID_INPUT", "Escolha a modalidade."));
  const room = clean(input.room) || null;
  if (room && room.length > 40) return fail(examError("INVALID_INPUT", "A sala tem no máximo 40 caracteres."));
  const notes = cleanLong(input.notes) || null;
  if (notes && notes.length > 500) return fail(examError("INVALID_INPUT", "As observações têm no máximo 500 caracteres."));
  return ok({ day: input.day, startsAt: input.startsAt, endsAt: input.endsAt, room, format: input.format as ExamFormat, notes });
}

export function checkReason(raw: string | null | undefined): Result<string, ExamError> {
  const t = clean(raw);
  return t.length < 3 || t.length > 300 ? fail(examError("INVALID_INPUT", "Indique o motivo (3 a 300 caracteres).")) : ok(t);
}

/** Sem repetidos; os que impedem primeiro. */
export function tidy(list: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.message) && seen.add(c.message)).sort((a, b) => (a.level === b.level ? 0 : a.level === "BLOCK" ? -1 : 1));
}
