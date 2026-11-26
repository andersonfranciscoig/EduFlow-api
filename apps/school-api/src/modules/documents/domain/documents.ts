import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";

/**
 * DOCUMENTOS — o que se pode pedir (tipos configuráveis por colégio), os pedidos e a sua máquina
 * de estados. Regras puras (sem BD): validação dos tipos e das respostas, transições permitidas.
 */
export type DocumentsErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "NAME_TAKEN" | "CHANGED" | "NOT_AVAILABLE";
export type DocumentsError = DomainError<DocumentsErrorCode>;
export const documentsError = (code: DocumentsErrorCode, message: string, meta?: Record<string, unknown>): DocumentsError => new DomainError(code, message, meta);

export type Audience = "STUDENT" | "EMPLOYEE";
export type Department = "SECRETARIA" | "PEDAGOGIA" | "RH";
export type Method = "AUTO" | "EXTERNAL";
export const AUDIENCES: Record<Audience, string> = { STUDENT: "Alunos e encarregados", EMPLOYEE: "Funcionários" };
export const DEPARTMENTS: Record<Department, string> = { SECRETARIA: "Secretaria", PEDAGOGIA: "Área pedagógica", RH: "Recursos Humanos" };
export const METHODS: Record<Method, { label: string; hint: string }> = {
  AUTO: { label: "Emissão automática", hint: "O sistema gera o documento com um modelo e os dados que já tem." },
  EXTERNAL: { label: "Preparado pelo colégio", hint: "O colégio prepara o documento fora da plataforma e atualiza o pedido." },
};
/** Categorias sugeridas (o colégio pode escrever outra). */
export const CATEGORIES: Record<Audience, string[]> = {
  STUDENT: ["Documentos escolares", "Documentos académicos", "Documentos administrativos", "Documentos de matrícula", "Cartões de estudante"],
  EMPLOYEE: ["Documentos de funcionários", "Documentos administrativos"],
};

// ---------------------------------------------------------------- campos extra do formulário

export type FieldKind = "TEXT" | "LONG_TEXT" | "DATE" | "NUMBER" | "CHOICE";
export const FIELD_KINDS: Record<FieldKind, string> = { TEXT: "Texto curto", LONG_TEXT: "Texto longo", DATE: "Data", NUMBER: "Número", CHOICE: "Escolha" };
export interface ExtraField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options: string[];
  hint: string | null;
}
const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const slug = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** Os campos extra de um tipo: até 10, com nome, tipo e (na escolha) as opções. */
export function checkFields(list: unknown[]): { ok: true; fields: ExtraField[] } | { ok: false; message: string } {
  if (!Array.isArray(list) || list.length > 10) return { ok: false, message: "No máximo 10 campos extra." };
  const out: ExtraField[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const label = clean(raw?.label, 80);
    if (label.length < 2) return { ok: false, message: "Cada campo extra precisa de um nome (2 a 80 caracteres)." };
    const kind = String(raw?.kind ?? "TEXT") as FieldKind;
    if (!(kind in FIELD_KINDS)) return { ok: false, message: `Tipo de campo desconhecido em “${label}”.` };
    const options = kind === "CHOICE" ? [...new Set(((raw?.options as unknown[]) ?? []).map((o) => clean(o, 80)).filter(Boolean))] : [];
    if (kind === "CHOICE" && (options.length < 2 || options.length > 20)) return { ok: false, message: `“${label}”: uma escolha precisa de 2 a 20 opções.` };
    let key = slug(String(raw?.key ?? "") || label) || "campo";
    while (out.some((f) => f.key === key)) key = `${key}-${out.length + 1}`;
    out.push({ key, label, kind, required: !!raw?.required, options, hint: clean(raw?.hint, 200) || null });
  }
  return { ok: true, fields: out };
}

/** As respostas aos campos extra: só os campos do tipo; os obrigatórios preenchidos; formatos certos. */
export function checkAnswers(fields: ExtraField[], answers: Record<string, unknown> | null | undefined): { ok: true; answers: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = clean(answers?.[f.key], f.kind === "LONG_TEXT" ? 1000 : 200);
    if (!v) {
      if (f.required) return { ok: false, message: `Preencha “${f.label}”.` };
      continue;
    }
    if (f.kind === "DATE" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, message: `“${f.label}”: data inválida.` };
    if (f.kind === "NUMBER" && !/^-?\d+([.,]\d+)?$/.test(v)) return { ok: false, message: `“${f.label}”: escreva um número.` };
    if (f.kind === "CHOICE" && !f.options.includes(v)) return { ok: false, message: `“${f.label}”: escolha uma das opções.` };
    out[f.key] = v;
  }
  return { ok: true, answers: out };
}

// ---------------------------------------------------------------- pedidos

export type RequestStatus = "PENDING" | "IN_REVIEW" | "AWAITING_PAYMENT" | "PROCESSING" | "READY_PICKUP" | "READY_DOWNLOAD" | "COMPLETED" | "REJECTED" | "CANCELLED";
export const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING: "Pendente",
  IN_REVIEW: "Em análise",
  AWAITING_PAYMENT: "Aguarda pagamento",
  PROCESSING: "Em processamento",
  READY_PICKUP: "Disponível para levantamento",
  READY_DOWNLOAD: "Disponível para download",
  COMPLETED: "Concluído",
  REJECTED: "Rejeitado",
  CANCELLED: "Cancelado",
};
export const OPEN_STATUSES: RequestStatus[] = ["PENDING", "IN_REVIEW", "AWAITING_PAYMENT", "PROCESSING", "READY_PICKUP", "READY_DOWNLOAD"];

/** DOC-<ano>-<n.º com 6 algarismos>: único no colégio (a sequência não se repete). */
export const requestNumber = (year: number, n: number) => `DOC-${year}-${String(n).padStart(6, "0")}`;

export type StaffAction = "review" | "process" | "ready_pickup" | "reject" | "cancel";
export interface Snapshot {
  status: RequestStatus;
  requiresApproval: boolean;
  pickup: boolean;
  download: boolean;
}

/**
 * As transições que a equipa pode fazer. Cada uma diz de onde pode partir; o resto é recusado.
 *  - analisar: Pendente → Em análise
 *  - preparar: Em análise → Em processamento (ou Pendente → Em processamento, se o tipo não pede aprovação)
 *  - pronto a levantar: Em processamento → Disponível para levantamento (se o tipo tem levantamento)
 *  - rejeitar (com motivo): de Pendente, Em análise, Aguarda pagamento ou Em processamento
 *  - cancelar (com motivo): de qualquer estado aberto que ainda não foi entregue
 * A entrega (Disponível para levantamento → Concluído) faz-se com o registo de quem recebeu.
 */
export function staffTransition(r: Snapshot, action: StaffAction): { ok: true; to: RequestStatus } | { ok: false; message: string } {
  const from = r.status;
  const no = (why: string) => ({ ok: false as const, message: why });
  switch (action) {
    case "review":
      return from === "PENDING" ? { ok: true, to: "IN_REVIEW" } : no(`Só se começa a analisar um pedido pendente (este está “${STATUS_LABELS[from]}”).`);
    case "process":
      if (from === "IN_REVIEW") return { ok: true, to: "PROCESSING" };
      if (from === "PENDING") return r.requiresApproval ? no("Este documento precisa de aprovação: comece por analisar o pedido.") : { ok: true, to: "PROCESSING" };
      return no(`Não se pode passar a preparação um pedido “${STATUS_LABELS[from]}”.`);
    case "ready_pickup":
      if (!r.pickup) return no("Este documento não se levanta no colégio.");
      return from === "PROCESSING" ? { ok: true, to: "READY_PICKUP" } : no("Só fica disponível para levantamento um pedido em processamento.");
    case "reject":
      return ["PENDING", "IN_REVIEW", "AWAITING_PAYMENT", "PROCESSING"].includes(from) ? { ok: true, to: "REJECTED" } : no(`Não se pode rejeitar um pedido “${STATUS_LABELS[from]}”.`);
    case "cancel":
      return OPEN_STATUSES.includes(from) ? { ok: true, to: "CANCELLED" } : no(`Não se pode cancelar um pedido “${STATUS_LABELS[from]}”.`);
  }
}

/** Quem pediu pode cancelar enquanto o colégio ainda não começou a preparar o documento. */
export const requesterCanCancel = (s: RequestStatus) => s === "PENDING" || s === "IN_REVIEW" || s === "AWAITING_PAYMENT";
/** A entrega física: só de um pedido disponível para levantamento. */
export const canDeliver = (s: RequestStatus) => s === "READY_PICKUP";

/** A data prevista: hoje + o prazo do tipo (dias corridos). */
export function dueOn(today: string, slaDays: number) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + slaDays);
  return d.toISOString().slice(0, 10);
}
