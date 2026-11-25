import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { luandaToday } from "../../family/domain/family";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { EXPENSE_METHODS, expenseNumber } from "../domain/expenses";
import { CHARGE_KINDS, isDay, lateFee, METHOD_LABELS, type PaymentError, paymentError, paymentNumber } from "../domain/payments";
import type { PrismaFinanceReports, YearRow } from "../infrastructure/prisma-finance-reports";

/** Um relatório é sempre o mesmo formato (números, e tabelas com as colunas descritas): ecrã, papel e Excel usam o mesmo. */
export interface Column {
  label: string;
  kind: "text" | "money" | "int" | "date";
}
export interface Section {
  title: string;
  columns: Column[];
  rows: (string | number | null)[][];
  /** linha de total (null = sem) */
  total: (string | number | null)[] | null;
}
export interface Report {
  type: ReportType;
  title: string;
  scope: string;
  from: string | null;
  to: string | null;
  summary: { label: string; value: number; kind: "money" | "int"; hint?: string }[];
  sections: Section[];
  truncated: boolean;
}
export const REPORT_TYPES = {
  RECEITAS: { label: "Receitas", hint: "O que entrou (pagamentos validados), por tipo e por conta.", period: true },
  DIVIDAS: { label: "Dívidas", hint: "O que cada aluno tem por pagar e em atraso, por classe.", period: false },
  DESPESAS: { label: "Despesas", hint: "O que saiu (despesas pagas), por categoria.", period: true },
  RESULTADO: { label: "Resultado", hint: "Receitas, despesas e saldo de cada mês.", period: true },
  ISENCOES: { label: "Isenções", hint: "As cobranças isentas e o motivo de cada uma.", period: true },
} as const;
export type ReportType = keyof typeof REPORT_TYPES;
const LIMIT = 3000;
const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((n, x) => n + f(x), 0);
const cls = (c: { grade: number | null; courseName: string | null }) => (c.grade === null ? "Sem classe" : `${gradeLabel(c.grade)}${c.courseName ? ` — ${c.courseName}` : ""}`);
const c = (label: string, kind: Column["kind"] = "text"): Column => ({ label, kind });
function months(from: string, to: string) {
  const out: string[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 40; ) {
    out.push(m);
    const [y, n] = m.split("-").map(Number);
    m = new Date(Date.UTC(y, n, 1)).toISOString().slice(0, 7);
  }
  return out;
}

export class FinanceReports {
  constructor(private readonly clock: Clock) {}

  private pickYear(years: YearRow[], wanted: string | undefined, today: string) {
    return years.find((y) => y.id === wanted) ?? years.find((y) => y.status === "ACTIVE") ?? years.find((y) => y.startsOn <= today && today <= y.endsOn) ?? years[0] ?? null;
  }

  /** O painel: os números do ano letivo e os gráficos. */
  async overview(repo: PrismaFinanceReports, wanted?: string) {
    const today = luandaToday(this.clock.now());
    const years = await repo.years();
    const year = this.pickYear(years, wanted, today);
    if (!year) return { today, years, year: null };
    const { startsOn: from, endsOn: to } = year;
    const [byMonth, byMethod, byKind, spent, categories, waiting, totals, monthly, overdue, pending] = await Promise.all([
      repo.receivedBy("month", from, to),
      repo.receivedBy("method", from, to),
      repo.receivedByKind(from, to),
      repo.expensesBy("month", from, to),
      repo.expensesBy("category", from, to),
      repo.waiting(),
      repo.chargeTotals(year.id, today),
      repo.monthly(year.id, today),
      repo.overdueByClass(year.id, today),
      repo.expensesWaiting(today),
    ]);
    const month = today.slice(0, 7);
    const at = (list: { key: string; total: number }[], key: string) => list.find((x) => x.key === key)?.total ?? 0;
    return {
      today,
      years,
      year,
      totals: {
        received: sum(byMonth, (x) => x.total),
        receivedMonth: at(byMonth, month),
        spent: sum(spent, (x) => x.total),
        spentMonth: at(spent, month),
        waiting: waiting.total,
        waitingCount: waiting.n,
        ...totals,
        expensesPending: pending.total,
        expensesOverdue: pending.overdue,
        /** propinas já vencidas: quanto se cobrou do que se esperava */
        collection: (() => {
          const past = monthly.filter((m) => m.month <= month);
          const expected = sum(past, (m) => m.expected);
          return expected ? Math.round((sum(past, (m) => m.paid) / expected) * 100) : null;
        })(),
      },
      byMonth: months(from, to).map((m) => ({ month: m, received: at(byMonth, m), spent: at(spent, m) })),
      monthly,
      byMethod: byMethod.map((m) => ({ key: m.key, label: METHOD_LABELS[m.key as keyof typeof METHOD_LABELS] ?? m.key, count: m.n, total: m.total })),
      byKind: byKind.map((k) => ({ key: k.key, label: CHARGE_KINDS[k.key as keyof typeof CHARGE_KINDS] ?? k.key, count: k.n, total: k.total })),
      overdueByClass: overdue.map((o) => ({ classId: o.classId, label: cls(o), students: o.students, charges: o.n, total: o.total })),
      expensesByCategory: categories.map((k) => ({ label: k.key, count: k.n, total: k.total })),
    };
  }

  async options(repo: PrismaFinanceReports, wanted?: string) {
    const today = luandaToday(this.clock.now());
    const years = await repo.years();
    const year = this.pickYear(years, wanted, today);
    return { today, years, yearId: year?.id ?? null, classes: year ? await repo.classes(year.id) : [], types: Object.entries(REPORT_TYPES).map(([value, t]) => ({ value, ...t })) };
  }

  async report(repo: PrismaFinanceReports, type: ReportType, q: { from?: string; to?: string; yearId?: string; classId?: string }): Promise<Result<Report, PaymentError>> {
    const today = luandaToday(this.clock.now());
    const years = await repo.years();
    const year = this.pickYear(years, q.yearId, today);
    const base = { type, title: REPORT_TYPES[type].label };
    if (type === "DIVIDAS") {
      if (!year) return fail(paymentError("NOT_FOUND", "Ainda não há ano letivo."));
      const classes = await repo.classes(year.id);
      const chosen = q.classId ? classes.find((x) => x.id === q.classId) : null;
      if (q.classId && !chosen) return fail(paymentError("NOT_FOUND", "Classe não encontrada."));
      const rows = await repo.debts(year.id, q.classId ?? null, LIMIT);
      const items = rows.map((r) => ({ ...r, late: !!r.dueOn && r.dueOn < today, fee: lateFee(r.amount, r.dueOn, today, r.planKind ? { kind: r.planKind, value: r.planValue ?? 0 } : null) }));
      const by = <K>(key: (x: (typeof items)[number]) => K) => [...items.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map<K, typeof items>())];
      const perClass = by((x) => cls(x)).map(([label, l]) => [label, new Set(l.map((x) => x.studentKey)).size, sum(l, (x) => x.amount), sum(l.filter((x) => x.late), (x) => x.amount)]);
      const perStudent = by((x) => x.studentKey).map(([, l]) => {
        const late = l.filter((x) => x.late);
        return [l[0].student, l[0].number ? String(l[0].number).padStart(5, "0") : "—", cls(l[0]), l.find((x) => x.groupName)?.groupName ?? "—", l.length, late.length ? late.map((x) => x.dueOn!).sort()[0] : null, sum(late, (x) => x.amount), sum(l, (x) => x.fee), sum(l, (x) => x.amount + x.fee)];
      });
      const total = sum(items, (x) => x.amount);
      const late = sum(items.filter((x) => x.late), (x) => x.amount);
      const fees = sum(items, (x) => x.fee);
      return ok({
        ...base,
        scope: [year.name, chosen ? cls(chosen) : "Todas as classes"].join(" · "),
        from: null,
        to: null,
        summary: [
          { label: "Por pagar", value: total, kind: "money", hint: "sem o que está em validação" },
          { label: "Em atraso", value: late, kind: "money" },
          { label: "Multas", value: fees, kind: "money", hint: "se pagassem hoje" },
          { label: "Alunos", value: perStudent.length, kind: "int" },
        ],
        sections: [
          { title: "Por classe", columns: [c("Classe"), c("Alunos", "int"), c("Por pagar", "money"), c("Em atraso", "money")], rows: perClass, total: ["Total", sum(perClass, (x) => x[1] as number), total, late] },
          { title: "Por aluno", columns: [c("Aluno"), c("N.º"), c("Classe"), c("Turma"), c("Cobranças", "int"), c("Em atraso desde", "date"), c("Em atraso", "money"), c("Multa", "money"), c("Total", "money")], rows: perStudent, total: ["Total", null, null, null, items.length, null, late, fees, total + fees] },
        ],
        truncated: rows.length >= LIMIT,
      });
    }
    // os restantes são de um período: por omissão, o ano letivo
    const from = q.from ?? year?.startsOn ?? `${today.slice(0, 4)}-01-01`;
    const to = q.to ?? year?.endsOn ?? today;
    if (!isDay(from) || !isDay(to) || from > to) return fail(paymentError("INVALID_INPUT", "Escolha um período válido."));
    if (new Date(to).getTime() - new Date(from).getTime() > 800 * 86_400_000) return fail(paymentError("INVALID_INPUT", "O período tem no máximo dois anos."));
    const scope = !q.from && !q.to && year ? year.name : "Entre datas";
    if (type === "RECEITAS") {
      const [kinds, banks, rows] = await Promise.all([repo.receivedByKind(from, to), repo.receivedBy("bank", from, to), repo.payments(from, to, LIMIT)]);
      const total = sum(banks, (x) => x.total);
      const n = sum(banks, (x) => x.n);
      return ok({
        ...base,
        scope,
        from,
        to,
        summary: [
          { label: "Recebido", value: total, kind: "money" },
          { label: "Pagamentos", value: n, kind: "int", hint: "validados" },
          { label: "Multas incluídas", value: sum(rows, (x) => x.lateFee), kind: "money" },
        ],
        sections: [
          { title: "Por tipo", columns: [c("Tipo"), c("Cobranças", "int"), c("Valor", "money")], rows: kinds.map((k) => [CHARGE_KINDS[k.key as keyof typeof CHARGE_KINDS] ?? k.key, k.n, k.total]), total: ["Total", sum(kinds, (k) => k.n), sum(kinds, (k) => k.total)] },
          { title: "Por conta", columns: [c("Conta"), c("Pagamentos", "int"), c("Valor", "money")], rows: banks.map((b) => [b.key, b.n, b.total]), total: ["Total", n, total] },
          {
            title: "Pagamentos",
            columns: [c("Data", "date"), c("N.º"), c("Aluno"), c("O quê"), c("Forma"), c("Conta"), c("Transação"), c("Valor", "money")],
            rows: rows.map((p) => [p.paidOn, paymentNumber(p.number), p.students, p.items, METHOD_LABELS[p.method as keyof typeof METHOD_LABELS] ?? p.method, p.bankName, p.transaction, p.total]),
            total: rows.length >= LIMIT ? null : ["Total", null, null, null, null, null, null, sum(rows, (p) => p.total)],
          },
        ],
        truncated: rows.length >= LIMIT,
      });
    }
    if (type === "DESPESAS") {
      const [cats, rows] = await Promise.all([repo.expensesBy("category", from, to), repo.expenses(from, to, LIMIT)]);
      const total = sum(cats, (x) => x.total);
      return ok({
        ...base,
        scope,
        from,
        to,
        summary: [
          { label: "Pago", value: total, kind: "money" },
          { label: "Despesas", value: sum(cats, (x) => x.n), kind: "int" },
        ],
        sections: [
          { title: "Por categoria", columns: [c("Categoria"), c("Despesas", "int"), c("Valor", "money")], rows: cats.map((k) => [k.key, k.n, k.total]), total: ["Total", sum(cats, (k) => k.n), total] },
          {
            title: "Despesas",
            columns: [c("Data", "date"), c("N.º"), c("Categoria"), c("Descrição"), c("Fornecedor"), c("Documento"), c("Forma"), c("Valor", "money")],
            rows: rows.map((e) => [e.paidOn, expenseNumber(e.number), e.category, e.description, e.supplier ?? "—", e.documentNumber ?? "—", [EXPENSE_METHODS[e.method as keyof typeof EXPENSE_METHODS] ?? e.method, e.bankName].filter(Boolean).join(" · "), e.amount]),
            total: rows.length >= LIMIT ? null : ["Total", null, null, null, null, null, null, sum(rows, (e) => e.amount)],
          },
        ],
        truncated: rows.length >= LIMIT,
      });
    }
    if (type === "RESULTADO") {
      const [inn, out] = await Promise.all([repo.receivedBy("month", from, to), repo.expensesBy("month", from, to)]);
      const rows = months(from, to).map((m) => {
        const a = inn.find((x) => x.key === m)?.total ?? 0;
        const b = out.find((x) => x.key === m)?.total ?? 0;
        return [m, a, b, a - b];
      });
      const a = sum(inn, (x) => x.total);
      const b = sum(out, (x) => x.total);
      return ok({
        ...base,
        scope,
        from,
        to,
        summary: [
          { label: "Receitas", value: a, kind: "money" },
          { label: "Despesas", value: b, kind: "money" },
          { label: "Saldo", value: a - b, kind: "money" },
        ],
        sections: [{ title: "Por mês", columns: [c("Mês"), c("Receitas", "money"), c("Despesas", "money"), c("Saldo", "money")], rows, total: ["Total", a, b, a - b] }],
        truncated: false,
      });
    }
    const rows = await repo.waivers(from, to, LIMIT);
    const total = sum(rows, (x) => x.amount);
    return ok({
      ...base,
      scope,
      from,
      to,
      summary: [
        { label: "Isento", value: total, kind: "money" },
        { label: "Cobranças", value: rows.length, kind: "int" },
      ],
      sections: [{ title: "Isenções", columns: [c("Data", "date"), c("Aluno"), c("Classe"), c("O quê"), c("Motivo"), c("Por"), c("Valor", "money")], rows: rows.map((w) => [w.day, w.student, cls(w), w.label, w.reason ?? "—", w.by ?? "—", w.amount]), total: ["Total", null, null, null, null, null, total] }],
      truncated: rows.length >= LIMIT,
    });
  }
}
