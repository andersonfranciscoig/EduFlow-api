import { createHash } from "node:crypto";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { conflictsOf, dmy, type ExamCtx, type ExamError, examError, type LessonCtx, MAX_PER_DAY, type SeasonCtx, weekdayOf, type YearCtx } from "./exams";

/**
 * GERAÇÃO AUTOMÁTICA de uma proposta de calendário para uma época EM PREPARAÇÃO.
 *   - coloca as provas em falta (turma × disciplina abrangidas), sem criar conflitos que impedem;
 *   - com interrupção das aulas: tempos seguidos dentro do turno da turma;
 *     sem interrupção: de preferência na aula da própria disciplina;
 *   - distribui pelos dias (máximo por dia; disciplinas com mais tempos não ficam coladas);
 *   - a mesma prova das turmas de uma classe pode ser em simultâneo.
 * É determinística: os mesmos dados, regras e variante (`seed`) dão sempre a mesma proposta — o que se
 * viu é o que se grava (a impressão digital confirma-o). "Outra proposta" = outra variante.
 */
export type GenerateMode = "FILL" | "REGENERATE" | "REPLACE";
export const MODE_LABELS: Record<GenerateMode, string> = {
  FILL: "Completar: só as que faltam",
  REGENERATE: "Gerar de novo: mantém as marcadas ou ajustadas à mão",
  REPLACE: "Começar do zero: substitui todas",
};
export interface GenerateOptions {
  mode: GenerateMode;
  /** minutos de cada prova (com interrupção, ou quando não há aula da disciplina) */
  duration: number;
  /** minutos entre duas provas da mesma turma no mesmo dia */
  interval: number;
  maxPerDay: number;
  /** 1 = segunda … 6 = sábado */
  weekdays: number[];
  /** as turmas da mesma classe e turno fazem a mesma prova à mesma hora */
  common: boolean;
  seed: number;
}
export interface Weighted {
  classId: string;
  subjectId: string;
  name: string;
  color: string;
  weekly: number;
}
export interface Placed {
  groupId: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  teacherId: string | null;
  teacherName: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  warnings: string[];
}
export interface Unplaced {
  groupId: string;
  subjectId: string;
  subjectName: string;
  reason: string;
}
export interface Proposal {
  placed: Placed[];
  unplaced: Unplaced[];
  /** provas que já estavam marcadas e se mantêm */
  kept: ExamCtx[];
  /** provas que a proposta substitui */
  removed: ExamCtx[];
  days: string[];
  fingerprint: string;
}

export function checkOptions(o: GenerateOptions): Result<GenerateOptions, ExamError> {
  if (!(o.mode in MODE_LABELS)) return fail(examError("INVALID_INPUT", "Escolha o que fazer com as provas já marcadas."));
  if (!Number.isInteger(o.duration) || o.duration < 30 || o.duration > 240) return fail(examError("INVALID_INPUT", "Cada prova dura entre 30 minutos e 4 horas."));
  if (!Number.isInteger(o.interval) || o.interval < 0 || o.interval > 120) return fail(examError("INVALID_INPUT", "O intervalo entre provas vai de 0 a 120 minutos."));
  if (!Number.isInteger(o.maxPerDay) || o.maxPerDay < 1 || o.maxPerDay > 4) return fail(examError("INVALID_INPUT", "Entre 1 e 4 provas por dia para cada turma."));
  const weekdays = [...new Set(o.weekdays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 6).sort();
  if (!weekdays.length) return fail(examError("INVALID_INPUT", "Escolha pelo menos um dia da semana."));
  return ok({ ...o, weekdays, seed: Math.abs(Math.trunc(o.seed)) % 10_000 });
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** Aleatório com semente (a variante muda a ordem e os empates). */
function random(seed: number) {
  let a = (seed + 1) * 0x9e3779b1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Os dias em que se pode fazer provas: dentro da época, de hoje em diante, nos dias escolhidos e sem feriados. */
export function examDays(ctx: YearCtx, season: SeasonCtx, weekdays: number[], today: string): string[] {
  const out: string[] = [];
  if (!season.startsOn || !season.endsOn) return out;
  for (let d = season.startsOn > today ? season.startsOn : today; d <= season.endsOn; d = addDays(d, 1)) {
    if (weekdays.includes(weekdayOf(d)) && !ctx.closures.some((c) => d >= c.startsOn && d <= c.endsOn)) out.push(d);
  }
  return out;
}

interface Unit {
  classId: string;
  subject: Weighted;
  groups: { id: string; teacherId: string | null; teacherName: string | null }[];
}
/** Quanto custa cada aviso (quanto mais alto, mais se evita). */
const WARN_COST: Record<string, number> = { TEACHER_COMMON: 0, ROOM_SHARED: 8, MANY_SAME_DAY: 6, LESSON: 30, TEACHER_LESSON: 12, OUT_OF_SHIFT: 60, PAST: 100 };
/** Avisos que não se mostram na proposta: são o que se pediu (prova em simultâneo). */
const QUIET = new Set(["TEACHER_COMMON"]);

/** Junta aulas seguidas da disciplina no mesmo dia (ex.: dois tempos → uma prova de dois tempos). */
function lessonBlocks(lessons: LessonCtx[]) {
  const out: { startsAt: string; endsAt: string }[] = [];
  for (const l of [...lessons].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const last = out[out.length - 1];
    if (last && toMin(l.startsAt) - toMin(last.endsAt) <= 5) last.endsAt = l.endsAt;
    else out.push({ startsAt: l.startsAt, endsAt: l.endsAt });
  }
  return out;
}

export function generate(
  ctx: YearCtx,
  season: SeasonCtx,
  plan: Weighted[],
  teachers: { groupTeachers: { groupId: string; subjectId: string; employeeId: string }[]; names: Map<string, string> },
  opts: GenerateOptions,
  today: string,
): Proposal {
  const mine = ctx.exams.filter((e) => e.seasonId === season.id && e.status === "SCHEDULED");
  const removed = opts.mode === "FILL" ? [] : mine.filter((e) => opts.mode === "REPLACE" || e.source === "AUTOMATIC");
  const gone = new Set(removed.map((e) => e.id));
  const kept = mine.filter((e) => !gone.has(e.id));
  const others = ctx.exams.filter((e) => e.status === "SCHEDULED" && !gone.has(e.id));
  const days = examDays(ctx, season, opts.weekdays, today);

  // ---- o que falta marcar
  const has = new Set(kept.map((e) => `${e.groupId}:${e.subjectId}`));
  const units = new Map<string, Unit>();
  for (const g of ctx.groups) {
    if (!season.groupIds.includes(g.id)) continue;
    for (const s of season.subjects) {
      if (s.classId !== g.classId || has.has(`${g.id}:${s.subjectId}`)) continue;
      const subject = plan.find((p) => p.classId === g.classId && p.subjectId === s.subjectId);
      if (!subject) continue;
      const teacherId = teachers.groupTeachers.find((t) => t.groupId === g.id && t.subjectId === s.subjectId)?.employeeId ?? null;
      const key = opts.common ? `${g.classId}:${g.shift}:${s.subjectId}` : `${g.id}:${s.subjectId}`;
      const u = units.get(key) ?? { classId: g.classId, subject, groups: [] };
      u.groups.push({ id: g.id, teacherId, teacherName: teacherId ? (teachers.names.get(teacherId) ?? null) : null });
      units.set(key, u);
    }
  }

  // várias tentativas (ordens diferentes): fica a que deixa menos por marcar e a de menor custo
  // pela chave: a mesma ordem de partida, venha como vier da BD
  const list = [...units.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, u]) => u);
  for (const u of list) u.groups.sort((a, b) => a.id.localeCompare(b.id));
  const weights = new Map(plan.map((p) => [`${p.classId}:${p.subjectId}`, p.weekly]));
  const tries = list.length > 250 ? 2 : list.length > 80 ? 4 : 8;
  let best: { placed: Placed[]; unplaced: Unplaced[]; cost: number } | null = null;
  for (let i = 0; i < tries; i++) {
    const r = attempt(ctx, season, list, others, weights, days, opts, today, random(opts.seed * 97 + i));
    if (!best || r.unplaced.length < best.unplaced.length || (r.unplaced.length === best.unplaced.length && r.cost < best.cost)) best = r;
  }
  const { placed, unplaced } = best ?? { placed: [], unplaced: [] };
  placed.sort((a, b) => a.day.localeCompare(b.day) || a.startsAt.localeCompare(b.startsAt) || a.subjectName.localeCompare(b.subjectName) || a.groupId.localeCompare(b.groupId));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([placed.map((p) => [p.groupId, p.subjectId, p.teacherId, p.day, p.startsAt, p.endsAt]), unplaced.map((u) => [u.groupId, u.subjectId]), [...gone].sort()]))
    .digest("hex")
    .slice(0, 24);
  return { placed, unplaced, kept, removed, days, fingerprint };
}

function attempt(ctx: YearCtx, season: SeasonCtx, units: Unit[], others: ExamCtx[], weights: Map<string, number>, days: string[], opts: GenerateOptions, today: string, rnd: () => number) {
  const groupOf = new Map(ctx.groups.map((g) => [g.id, g]));
  // por dia: as provas já postas e as aulas desse dia da semana (para verificar só o que conta)
  const byDay = new Map(days.map((d) => [d, others.filter((e) => e.day === d)]));
  const lessonsOn = new Map(days.map((d) => [d, ctx.lessons.filter((l) => l.weekday === weekdayOf(d))]));
  const dayCtx = new Map(days.map((d) => [d, { ...ctx, exams: byDay.get(d)!, lessons: lessonsOn.get(d)! } as YearCtx]));
  /** tempos por semana da disciplina na classe da turma */
  const weeklyOf = (e: { groupId: string; subjectId: string }) => weights.get(`${groupOf.get(e.groupId)?.classId}:${e.subjectId}`) ?? 0;
  const placed: Placed[] = [];
  const unplaced: Unplaced[] = [];
  let total = 0;
  let seq = 0;

  const slotsFor = (groupIds: string[], subjectId: string, day: string): { startsAt: string; endsAt: string; cost: number }[] => {
    const shifts = groupIds.map((id) => ctx.shifts.find((s) => s.shift === groupOf.get(id)!.shift) ?? { startsAt: "07:00", endsAt: "18:00" });
    const from = Math.max(...shifts.map((s) => toMin(s.startsAt)));
    const to = Math.min(...shifts.map((s) => toMin(s.endsAt)));
    const out: { startsAt: string; endsAt: string; cost: number }[] = [];
    if (!season.interrupts) {
      // a aula da própria disciplina (comum a todas as turmas da unidade)
      const own = groupIds.map((id) => lessonBlocks(lessonsOn.get(day)!.filter((l) => l.groupId === id && l.subjectId === subjectId)));
      for (const b of own[0] ?? []) if (toMin(b.endsAt) - toMin(b.startsAt) >= 30 && own.every((list) => list.some((x) => x.startsAt === b.startsAt && x.endsAt === b.endsAt))) out.push({ ...b, cost: 0 });
    }
    // tempos seguidos dentro do turno
    for (let s = from, i = 0; s + opts.duration <= to; s += opts.duration + opts.interval, i++) out.push({ startsAt: toTime(s), endsAt: toTime(s + opts.duration), cost: (season.interrupts ? 0 : 10) + i * 1.5 });
    // turno mais curto do que a prova: começa no início do turno
    if (!out.length && from + opts.duration <= 24 * 60 - 1) out.push({ startsAt: toTime(from), endsAt: toTime(from + opts.duration), cost: 20 });
    return out;
  };

  const place = (u: Unit): string | null => {
    let choice: { day: string; startsAt: string; endsAt: string; cost: number; warns: Map<string, string[]> } | null = null;
    let full = 0;
    let reason: string | null = null;
    for (const day of days) {
      const list = byDay.get(day)!;
      const counts = u.groups.map((g) => list.filter((e) => e.groupId === g.id).length);
      if (counts.some((n) => n >= opts.maxPerDay)) {
        full++;
        continue;
      }
      // distribuir: dias com menos provas; disciplinas com mais tempos não ficam em dias seguidos
      let base = Math.max(...counts) * 14;
      const at = days.indexOf(day);
      for (const near of [days[at - 1], days[at + 1]]) {
        if (!near) continue;
        for (const g of u.groups) for (const e of byDay.get(near)!) if (e.groupId === g.id) base += Math.min(u.subject.weekly, weeklyOf(e)) >= 4 ? 5 : 1;
      }
      for (const s of slotsFor(
        u.groups.map((g) => g.id),
        u.subject.subjectId,
        day,
      )) {
        if (u.groups.some((g) => list.some((e) => e.groupId === g.id && s.startsAt < toTime(Math.min(toMin(e.endsAt) + opts.interval, 1439)) && e.startsAt < toTime(Math.min(toMin(s.endsAt) + opts.interval, 1439))))) continue;
        let cost = base + s.cost + rnd() * 2;
        const warns = new Map<string, string[]>();
        let blocked = false;
        for (const g of u.groups) {
          const found = conflictsOf(dayCtx.get(day)!, { id: null, seasonId: season.id, groupId: g.id, subjectId: u.subject.subjectId, subjectName: u.subject.name, teacherId: g.teacherId, teacherName: g.teacherName, day, startsAt: s.startsAt, endsAt: s.endsAt, room: null, format: season.format }, today);
          const b = found.find((c) => c.level === "BLOCK");
          if (b) {
            blocked = true;
            reason ??= b.message;
            break;
          }
          const shown = found.filter((c) => !QUIET.has(c.code) && !(c.code === "MANY_SAME_DAY" && opts.maxPerDay > MAX_PER_DAY));
          if (shown.length)
            warns.set(
              g.id,
              shown.map((c) => c.message),
            );
          cost += found.reduce((n, c) => n + (WARN_COST[c.code] ?? 5), 0);
        }
        if (!blocked && (!choice || cost < choice.cost)) choice = { day, startsAt: s.startsAt, endsAt: s.endsAt, cost, warns };
      }
    }
    if (!choice) return !days.length ? "Não há dias disponíveis na época com os dias da semana escolhidos." : full === days.length ? `Não cabe: ${days.length === 1 ? "1 dia disponível" : `${days.length} dias disponíveis`} e no máximo ${opts.maxPerDay} por dia.` : (reason ?? "Não há hora livre nos dias disponíveis.");
    total += choice.cost;
    for (const g of u.groups) {
      placed.push({ groupId: g.id, subjectId: u.subject.subjectId, subjectName: u.subject.name, subjectColor: u.subject.color, teacherId: g.teacherId, teacherName: g.teacherName, day: choice.day, startsAt: choice.startsAt, endsAt: choice.endsAt, warnings: choice.warns.get(g.id) ?? [] });
      byDay.get(choice.day)!.push({
        id: `novo-${seq++}`,
        seasonId: season.id,
        groupId: g.id,
        subjectId: u.subject.subjectId,
        subjectName: u.subject.name,
        subjectColor: u.subject.color,
        teacherId: g.teacherId,
        teacherName: g.teacherName,
        day: choice.day,
        startsAt: choice.startsAt,
        endsAt: choice.endsAt,
        room: null,
        format: season.format,
        notes: null,
        status: "SCHEDULED",
        source: "AUTOMATIC",
        cancelReason: null,
        updatedAt: "",
      });
    }
    return null;
  };

  // primeiro o mais difícil: mais turmas juntas e mais tempos por semana (com algum acaso entre iguais)
  const order = units.map((u) => ({ u, k: u.groups.length * 3 + u.subject.weekly + rnd() * 4 })).sort((a, b) => b.k - a.k);
  for (const { u } of order) {
    const reason = place(u);
    if (!reason) continue;
    // em simultâneo não dá (horários ou professores diferentes): tenta turma a turma
    for (const g of u.groups) {
      const r = u.groups.length > 1 ? place({ ...u, groups: [g] }) : reason;
      if (r) unplaced.push({ groupId: g.id, subjectId: u.subject.subjectId, subjectName: u.subject.name, reason: r });
    }
  }
  return { placed, unplaced, cost: total };
}

export const placedText = (p: { subjectName: string; day: string; startsAt: string }, label: string) => `${p.subjectName} · ${label}: ${dmy(p.day)} ${p.startsAt}`;
