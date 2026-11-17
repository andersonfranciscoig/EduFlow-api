/**
 * CONTRATOS DOS FUNCIONÁRIOS.
 *   tipos      sem termo (indeterminado) · a termo (determinado) · prestação de serviços · estágio
 *              sem termo: sem data de fim · a termo e estágio: com data de fim · prestação: opcional
 *   estado     calculado pelas datas (hora de Luanda), nunca gravado:
 *                futuro (ainda não começou) → vigente → caducado (chegou ao fim) | rescindido
 *              "a terminar": vigente que acaba nos próximos 30 dias
 *   sobreposição  dois contratos do mesmo funcionário não podem cobrir o mesmo dia
 *   salário    kwanzas (inteiros); null = por definir. Só com a permissão hr.contracts.salary.
 */
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { isIsoDate } from "./employee";
import { type HrError, hrError } from "./form";

/** end: a data de fim é obrigatória, proibida ou opcional. */
export const CONTRACT_KINDS: Record<"INDETERMINADO" | "DETERMINADO" | "PRESTACAO_SERVICOS" | "ESTAGIO", { label: string; short: string; end: "required" | "forbidden" | "optional" }> = {
  INDETERMINADO: { label: "Sem termo (tempo indeterminado)", short: "Sem termo", end: "forbidden" },
  DETERMINADO: { label: "A termo (tempo determinado)", short: "A termo", end: "required" },
  PRESTACAO_SERVICOS: { label: "Prestação de serviços", short: "Prestação de serviços", end: "optional" },
  ESTAGIO: { label: "Estágio", short: "Estágio", end: "required" },
};
export type ContractKind = keyof typeof CONTRACT_KINDS;
export const CONTRACT_KIND_KEYS = Object.keys(CONTRACT_KINDS) as ContractKind[];

export const CONTRACT_REGIMES = { TEMPO_INTEIRO: "Tempo inteiro", TEMPO_PARCIAL: "Tempo parcial" } as const;
export type ContractRegime = keyof typeof CONTRACT_REGIMES;

export type ContractStatus = "FUTURO" | "VIGENTE" | "CADUCADO" | "RESCINDIDO";
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = { FUTURO: "Ainda não começou", VIGENTE: "Vigente", CADUCADO: "Caducado", RESCINDIDO: "Rescindido" };

/** Dias antes do fim em que um contrato vigente passa a "a terminar". */
export const EXPIRING_DAYS = 30;
/** Um contrato não dura mais de 10 anos (a renovação cria um novo). */
const MAX_YEARS = 10;
/** O período experimental não passa de 6 meses. */
const MAX_TRIAL_DAYS = 183;
export const MAX_SALARY = 1_000_000_000;

/** Funcionários que podem ter contratos (aprovados; suspensos continuam a ter o contrato). */
export const CONTRACTABLE = ["APPROVED", "ACTIVE", "SUSPENDED"] as const;

export interface ContractData {
  kind: ContractKind;
  regime: ContractRegime;
  weeklyHours: number;
  jobTitle: string;
  department: string | null;
  /** "AAAA-MM-DD" */
  startsOn: string;
  endsOn: string | null;
  trialEndsOn: string | null;
  notes: string | null;
}

export interface ContractDates {
  startsOn: string;
  endsOn: string | null;
  terminatedOn: string | null;
}

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || null;
const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(toTime(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY);

/** Valida os dados de um contrato (sem o salário, que tem permissão própria). */
export function checkContract(input: {
  kind: string;
  regime: string;
  weeklyHours: number;
  jobTitle: string;
  department?: string | null;
  startsOn: string;
  endsOn?: string | null;
  trialEndsOn?: string | null;
  notes?: string | null;
}): Result<ContractData, HrError> {
  const kind = CONTRACT_KINDS[input.kind as ContractKind];
  if (!kind) return fail(hrError("INVALID_INPUT", "Escolha o tipo de contrato."));
  if (!(input.regime in CONTRACT_REGIMES)) return fail(hrError("INVALID_INPUT", "Escolha o regime (tempo inteiro ou parcial)."));
  if (!Number.isInteger(input.weeklyHours) || input.weeklyHours < 1 || input.weeklyHours > 60) return fail(hrError("INVALID_INPUT", "As horas por semana vão de 1 a 60."));
  const jobTitle = clean(input.jobTitle);
  if (!jobTitle || jobTitle.length < 2 || jobTitle.length > 120) return fail(hrError("INVALID_INPUT", "Indique a função (2 a 120 caracteres)."));
  const department = clean(input.department);
  if (department && department.length > 120) return fail(hrError("INVALID_INPUT", "O departamento tem no máximo 120 caracteres."));
  if (!isIsoDate(input.startsOn)) return fail(hrError("INVALID_INPUT", "Data de início inválida."));
  const endsOn = input.endsOn || null;
  if (kind.end === "forbidden" && endsOn) return fail(hrError("INVALID_INPUT", "Um contrato sem termo não tem data de fim."));
  if (kind.end === "required" && !endsOn) return fail(hrError("INVALID_INPUT", "Indique a data de fim do contrato."));
  if (endsOn) {
    if (!isIsoDate(endsOn)) return fail(hrError("INVALID_INPUT", "Data de fim inválida."));
    if (endsOn < input.startsOn) return fail(hrError("INVALID_INPUT", "A data de fim tem de ser depois do início."));
    if (daysBetween(input.startsOn, endsOn) > MAX_YEARS * 366) return fail(hrError("INVALID_INPUT", `Um contrato dura no máximo ${MAX_YEARS} anos (renove-o depois).`));
  }
  const trialEndsOn = input.trialEndsOn || null;
  if (trialEndsOn) {
    if (!isIsoDate(trialEndsOn)) return fail(hrError("INVALID_INPUT", "Data do fim do período experimental inválida."));
    if (trialEndsOn < input.startsOn) return fail(hrError("INVALID_INPUT", "O período experimental acaba depois do início do contrato."));
    if (endsOn && trialEndsOn > endsOn) return fail(hrError("INVALID_INPUT", "O período experimental não pode passar do fim do contrato."));
    if (daysBetween(input.startsOn, trialEndsOn) > MAX_TRIAL_DAYS) return fail(hrError("INVALID_INPUT", "O período experimental dura no máximo 6 meses."));
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 1000) return fail(hrError("INVALID_INPUT", "As observações têm no máximo 1000 caracteres."));
  return ok({ kind: input.kind as ContractKind, regime: input.regime as ContractRegime, weeklyHours: input.weeklyHours, jobTitle, department, startsOn: input.startsOn, endsOn, trialEndsOn, notes });
}

export function checkSalary(v: number | null): Result<number | null, HrError> {
  if (v === null) return ok(null);
  if (!Number.isInteger(v) || v < 0 || v > MAX_SALARY) return fail(hrError("INVALID_INPUT", "O salário base é um valor em kwanzas, sem casas decimais."));
  return ok(v);
}

/** O último dia em que o contrato vale (rescisão ou fim); null = sem fim. */
export const effectiveEnd = (c: ContractDates) => (c.terminatedOn && (!c.endsOn || c.terminatedOn < c.endsOn) ? c.terminatedOn : c.endsOn);

/** O estado do contrato hoje e, se for vigente com fim, quantos dias faltam. */
export function contractStatus(c: ContractDates, today: string): { status: ContractStatus; daysLeft: number | null; expiring: boolean } {
  const end = effectiveEnd(c);
  if (c.startsOn > today) return { status: "FUTURO", daysLeft: null, expiring: false };
  if (end && end < today) return { status: c.terminatedOn && end === c.terminatedOn ? "RESCINDIDO" : "CADUCADO", daysLeft: null, expiring: false };
  const daysLeft = end ? daysBetween(today, end) : null;
  return { status: "VIGENTE", daysLeft, expiring: daysLeft !== null && daysLeft <= EXPIRING_DAYS };
}

/** Os dois contratos cobrem pelo menos um dia em comum? (sem fim = para sempre) */
export function contractsOverlap(a: ContractDates, b: ContractDates) {
  const ea = effectiveEnd(a);
  const eb = effectiveEnd(b);
  return (!eb || a.startsOn <= eb) && (!ea || b.startsOn <= ea);
}

/** Rescindir: a data fica dentro do contrato; a justificação é obrigatória. */
export function checkTermination(c: ContractDates, input: { terminatedOn: string; reason: string }): Result<{ terminatedOn: string; reason: string }, HrError> {
  if (c.terminatedOn) return fail(hrError("INVALID_STATE", "Este contrato já foi rescindido."));
  if (!isIsoDate(input.terminatedOn)) return fail(hrError("INVALID_INPUT", "Data da rescisão inválida."));
  if (input.terminatedOn < c.startsOn) return fail(hrError("INVALID_INPUT", "A rescisão não pode ser antes do início do contrato."));
  if (c.endsOn && input.terminatedOn > c.endsOn) return fail(hrError("INVALID_INPUT", "A rescisão não pode ser depois do fim do contrato."));
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (reason.length < 3 || reason.length > 500) return fail(hrError("INVALID_INPUT", "Indique o motivo da rescisão (3 a 500 caracteres)."));
  return ok({ terminatedOn: input.terminatedOn, reason });
}

/** N.º do contrato como aparece (ex.: CT-0007). */
export const formatContractNumber = (n: number) => `CT-${String(n).padStart(4, "0")}`;
