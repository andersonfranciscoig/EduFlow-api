/**
 * RENOVAÇÕES (fase G) — o aluno matriculado continua no ano seguinte.
 *   quem        a família do aluno (o próprio aluno maior, ou o encarregado que gere o educando menor)
 *   quando      no período de renovações do ano seguinte (configurado em Períodos)
 *   o quê       uma inscrição do processo RENOVACAO, já ligada ao aluno e preenchida com os dados que o
 *               colégio já tem; a família confirma/corrige por passos e submete. Depois segue o
 *               caminho de sempre: análise → vaga → matrícula (n.º de matrícula do novo ano).
 *   classe      a seguinte (a mesma área/curso, se já tiver curso); a secretaria decide na análise.
 */
import type { ApplicationStatus, Shift } from "./applications";

export type RenewalState = "OPEN" | "UPCOMING" | "CLOSED" | "NOT_SET" | "NO_CLASS" | "STARTED" | "ENROLLED";

export const RENEWAL_STATE_LABELS: Record<RenewalState, string> = {
  OPEN: "Renovação aberta",
  UPCOMING: "Abre em breve",
  CLOSED: "Período fechado",
  NOT_SET: "Ainda sem datas",
  NO_CLASS: "Sem classe seguinte",
  STARTED: "Renovação em curso",
  ENROLLED: "Renovada",
};

/** A janela de renovações de um ano letivo (ainda não encerrado). */
export interface RenewalWindow {
  id: string;
  name: string;
  /** início do ano letivo "AAAA-MM-DD" (para saber qual é o "ano seguinte") */
  startsOn: string;
  from: string | null;
  to: string | null;
}

/** A matrícula atual (mais recente, ativa) de que se parte. */
export interface CurrentEnrollment {
  yearId: string;
  yearName: string;
  yearStartsOn: string;
  grade: number;
  courseId: string | null;
  courseName: string | null;
  groupName: string | null;
  shift: Shift | null;
}

/** O ano letivo seguinte com renovações: o primeiro (por início) depois do ano da matrícula atual. */
export function nextWindow(windows: RenewalWindow[], current: CurrentEnrollment): RenewalWindow | null {
  return [...windows].filter((w) => w.startsOn > current.yearStartsOn && w.from && w.to).sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0] ?? null;
}

export const windowState = (w: RenewalWindow | null, today: string): "OPEN" | "UPCOMING" | "CLOSED" | "NOT_SET" => (!w || !w.from || !w.to ? "NOT_SET" : today < w.from ? "UPCOMING" : today > w.to ? "CLOSED" : "OPEN");

/** Uma renovação "ativa" (conta para não começar outra): tudo menos rejeitada/cancelada. */
export const ACTIVE_RENEWAL: ApplicationStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "APPROVED"];
