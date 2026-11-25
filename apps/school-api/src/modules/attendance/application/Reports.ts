import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type PeriodKind, periodName } from "../../pedagogy/domain/calendar";
import { isDay } from "../domain/occurrences";
import { localNow, rate } from "../domain/presence";
import { type AttendanceError, attendanceError, type AttendanceRules } from "../domain/settings";
import type { PrismaReportsRepository, ReportScope, ReportYear, Tally } from "../infrastructure/prisma-reports";

type R<T> = Promise<Result<T, AttendanceError>>;
/** Filtros pedidos: o período é "ano", o n.º de um período de avaliação, ou "datas" (com de/até). */
export interface ReportInput {
  yearId?: string;
  period?: string;
  from?: string;
  to?: string;
  classId?: string;
  groupId?: string;
  subjectId?: string;
  teacherId?: string;
}
const pct = (t: Tally) => rate({ present: t.present, late: t.lateMarks, total: t.total });
const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const tallyDto = (t: Tally) => ({ ...t, rate: pct(t) });
const STATUS: Record<string, string> = { REGISTADA: "Por justificar", JUSTIFICADA: "Justificada", ANULADA: "Anulada" };

/**
 * PAINÉIS E RELATÓRIOS da assiduidade, para cada área e com os filtros que lhe cabem:
 *   pedagogia    (attendance.reports.view) — presença dos alunos, aulas sem registo, provas
 *   RH           (attendance.teachers.view) — professores, faltas, pendências, justificações
 *   professor    só as suas aulas
 *   coordenador  só as turmas que coordena
 * São só leitura: os números vêm das mesmas tabelas de onde se registam.
 */
export class Reports {
  constructor(private readonly clock: Clock) {}

  /** O ano e o intervalo de datas; por omissão, o período de avaliação em curso (ou o ano todo). */
  private async resolve(repo: PrismaReportsRepository, rules: AttendanceRules, input: ReportInput) {
    const nowLocal = localNow(rules.timeZone, this.clock.now());
    const today = nowLocal.slice(0, 10);
    const years = await repo.years();
    const open = years.filter((y) => y.status !== "CLOSED").reverse();
    const year: ReportYear | undefined = years.find((y) => y.id === input.yearId) ?? years.find((y) => y.status === "ACTIVE") ?? open.find((y) => today >= y.startsOn && today <= y.endsOn) ?? open.find((y) => y.startsOn > today) ?? years[0];
    if (!year) return null;
    const periods = (await repo.periods(year.id)).map((p) => ({ ...p, name: periodName(year.periodKind as PeriodKind, p.position) }));
    const current = periods.find((p) => today >= p.startsOn && today <= p.endsOn);
    let period = input.period ?? (current ? String(current.position) : "ano");
    let from = year.startsOn;
    let to = year.endsOn;
    const chosen = periods.find((p) => String(p.position) === period);
    if (period === "datas" && input.from && input.to && isDay(input.from) && isDay(input.to) && input.from <= input.to) {
      from = input.from < year.startsOn ? year.startsOn : input.from;
      to = input.to > year.endsOn ? year.endsOn : input.to;
    } else if (chosen) {
      from = chosen.startsOn;
      to = chosen.endsOn;
    } else period = "ano";
    const scope: ReportScope = { yearId: year.id, from, to, classId: input.classId, groupId: input.groupId, subjectId: input.subjectId, teacherId: input.teacherId };
    return { nowLocal, today, years, year, periods, period, scope };
  }

  private filters(x: NonNullable<Awaited<ReturnType<Reports["resolve"]>>>) {
    return {
      today: x.today,
      years: x.years.map((y) => ({ id: y.id, name: y.name, status: y.status })),
      year: { id: x.year.id, name: x.year.name, startsOn: x.year.startsOn, endsOn: x.year.endsOn },
      periods: x.periods,
      period: x.period,
      from: x.scope.from,
      to: x.scope.to,
      classId: x.scope.classId ?? null,
      groupId: x.scope.groupId ?? null,
      subjectId: x.scope.subjectId ?? null,
      teacherId: x.scope.teacherId ?? null,
    };
  }

  /** A presença dos alunos no âmbito pedido (o mesmo para a pedagogia, o professor e o coordenador). */
  private async students(repo: PrismaReportsRepository, rules: AttendanceRules, x: NonNullable<Awaited<ReturnType<Reports["resolve"]>>>, only: { teacherId?: string; groupId?: string }) {
    const { scope, nowLocal } = x;
    const [options, tallies, absentees, atRisk, pendings, coverage, alerts] = await Promise.all([
      repo.options(scope.yearId, only),
      repo.tallies(scope),
      repo.absentees(scope, 40),
      repo.atRisk(scope, rules.absenceLimit, rules.consecutiveLimit),
      repo.pendings(scope, 40),
      rules.trackingSince ? repo.coverage(scope, rules.trackingSince, nowLocal) : [],
      repo.alerts(scope),
    ]);
    const label = new Map(options.groups.map((g) => [g.id, g.label]));
    const subject = new Map(options.subjects.map((s) => [s.id, s]));
    const cover = coverage.find((c) => c.kind === 3);
    const byGroup = new Map(coverage.filter((c) => c.kind === 2).map((c) => [c.group_id!, c]));
    return {
      filters: this.filters(x),
      options,
      rules: { absenceLimit: rules.absenceLimit, consecutiveLimit: rules.consecutiveLimit },
      totals: { ...tallyDto(tallies.totals), atRisk, alerts },
      coverage: cover ? { planned: cover.planned, recorded: cover.recorded, missing: cover.planned - cover.recorded, rate: ratio(cover.recorded, cover.planned), since: rules.trackingSince } : null,
      weeks: tallies.weeks.map((w) => ({ week: w.week, sessions: w.sessions, absent: w.absent, rate: pct(w) })),
      groups: [...tallies.groups]
        .map(([id, t]) => ({ id, label: label.get(id) ?? "—", ...tallyDto(t), coverage: byGroup.get(id) ? ratio(byGroup.get(id)!.recorded, byGroup.get(id)!.planned) : null }))
        .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)),
      subjects: [...tallies.subjects].map(([id, t]) => ({ id, name: subject.get(id)?.name ?? "—", color: subject.get(id)?.color ?? "#8eb69b", ...tallyDto(t) })).sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)),
      students: absentees.map((s) => ({
        ...s,
        groupLabel: label.get(s.groupId) ?? "—",
        rate: rate({ present: s.present, late: s.lateMarks, total: s.total }),
        alerts: [...(s.absent >= rules.absenceLimit ? [`${s.absent} faltas (limite ${rules.absenceLimit})`] : []), ...(s.streak >= rules.consecutiveLimit ? [`${s.streak} faltas seguidas`] : [])],
      })),
      pendings,
    };
  }

  async pedagogy(repo: PrismaReportsRepository, rules: AttendanceRules, actor: { canSeeExams: boolean }, input: ReportInput) {
    const x = await this.resolve(repo, rules, input);
    if (!x) return fail(attendanceError("NOT_FOUND", "Ainda não há anos letivos."));
    const [base, exams] = await Promise.all([this.students(repo, rules, x, {}), actor.canSeeExams ? repo.exams(x.scope) : null]);
    return ok({
      ...base,
      exams: exams?.map((e) => {
        const phase = !e.startsOn || !e.endsOn ? "POR_CONFIGURAR" : e.status === "DRAFT" ? "A_PREPARAR" : x.today < e.startsOn ? "PUBLICADA" : x.today <= e.endsOn ? "A_DECORRER" : "TERMINADA";
        return { ...e, periodName: x.periods.find((p) => p.position === e.period)?.name ?? `Período ${e.period}`, phase };
      }) ?? null,
    });
  }

  /** Professor: só as suas aulas (e as que substituiu). */
  async teacher(repo: PrismaReportsRepository, rules: AttendanceRules, userId: string, input: ReportInput) {
    const me = await repo.employeeOfUser(userId);
    if (!me) return fail(attendanceError("FORBIDDEN", "A sua conta não está ligada a um professor."));
    const x = await this.resolve(repo, rules, { ...input, teacherId: me.id });
    if (!x) return fail(attendanceError("NOT_FOUND", "Ainda não há anos letivos."));
    const [base, coordinates] = await Promise.all([this.students(repo, rules, x, { teacherId: me.id }), repo.coordinatedGroups(me.id, x.scope.yearId)]);
    return ok({ ...base, teacher: me, coordinates });
  }

  /** Coordenador: uma turma que coordena (todas as disciplinas e professores). */
  async coordination(repo: PrismaReportsRepository, rules: AttendanceRules, userId: string, groupId: string, input: ReportInput) {
    const me = await repo.employeeOfUser(userId);
    if (!me) return fail(attendanceError("FORBIDDEN", "A sua conta não está ligada a um professor."));
    const x = await this.resolve(repo, rules, { ...input, classId: undefined, groupId });
    const groups = x ? await repo.coordinatedGroups(me.id, x.scope.yearId) : [];
    if (!x || !groups.some((g) => g.id === groupId)) return fail(attendanceError("NOT_FOUND", "Turma não encontrada nas turmas que coordena."));
    return ok({ ...(await this.students(repo, rules, x, { groupId })), teacher: me, coordinates: groups });
  }

  async hr(repo: PrismaReportsRepository, rules: AttendanceRules, input: ReportInput): R<unknown> {
    const x = await this.resolve(repo, rules, { yearId: input.yearId, period: input.period, from: input.from, to: input.to, teacherId: input.teacherId });
    if (!x) return fail(attendanceError("NOT_FOUND", "Ainda não há anos letivos."));
    const [options, occ, pendings, open, coverage] = await Promise.all([
      repo.options(x.scope.yearId),
      repo.occurrences(x.scope),
      repo.pendings(x.scope, 60),
      repo.openPendingsByTeacher(x.scope),
      rules.trackingSince ? repo.coverage(x.scope, rules.trackingSince, x.nowLocal) : [],
    ]);
    const names = new Map(options.teachers.map((t) => [t.id, t.fullName]));
    const cover = new Map(coverage.filter((c) => c.kind === 1).map((c) => [c.teacher_id!, c]));
    const ids = [...new Set([...occ.byTeacher.map((o) => o.id), ...cover.keys(), ...open.keys()])];
    const more = await repo.names(ids.filter((i) => !names.has(i)));
    const all = coverage.find((c) => c.kind === 3);
    const teachers = ids
      .map((id) => {
        const o = occ.byTeacher.find((b) => b.id === id);
        const c = cover.get(id);
        return {
          id,
          fullName: o?.full_name ?? names.get(id) ?? more.get(id) ?? "—",
          planned: c?.planned ?? 0,
          recorded: c?.recorded ?? 0,
          late: c?.late ?? 0,
          coverage: c ? ratio(c.recorded, c.planned) : null,
          pending: open.get(id) ?? 0,
          faults: o?.faults ?? 0,
          justified: o?.justified ?? 0,
          delays: o?.delays ?? 0,
        };
      })
      .sort((a, b) => b.faults - a.faults || b.pending - a.pending || (a.coverage ?? 101) - (b.coverage ?? 101) || a.fullName.localeCompare(b.fullName));
    const n = (s: string) => occ.justifications.find((j) => j.status === s)?.n ?? 0;
    const sum = (k: "faults" | "justified" | "delays" | "automatic" | "annulled") => occ.byTeacher.reduce((a, b) => a + b[k], 0);
    return ok({
      filters: this.filters(x),
      teachersOptions: options.teachers,
      model: rules.teacherModel,
      procedure: rules.missingProcedure,
      totals: { faults: sum("faults"), justified: sum("justified"), delays: sum("delays"), automatic: sum("automatic"), annulled: sum("annulled"), teachersLate: teachers.filter((t) => t.late > 0 || t.pending > 0).length },
      coverage: all ? { planned: all.planned, recorded: all.recorded, missing: all.planned - all.recorded, late: all.late, rate: ratio(all.recorded, all.planned), since: rules.trackingSince } : null,
      justifications: { pending: n("PENDING"), approved: n("APPROVED"), rejected: n("REJECTED") },
      weeks: occ.byWeek,
      teachers,
      pendings,
      occurrences: occ.list.map((o) => ({ ...o, kindLabel: o.kind === "FALTA" ? "Falta" : "Atraso", statusLabel: STATUS[o.status] ?? o.status, sourceLabel: o.source === "AUTOMATIC" ? "Automática" : "RH", what: o.what ?? "O dia" })),
    });
  }
}
