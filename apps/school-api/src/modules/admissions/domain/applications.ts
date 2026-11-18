/**
 * INSCRIÇÕES — o processo de um aluno, preenchido pela família (fase C).
 *   quem inscreve   conta GUARDIAN → um educando MENOR (o aluno com 18+ cria a própria conta)
 *                   conta STUDENT  → o próprio (a data de nascimento vem da conta, confirmada)
 *   passos          candidatura → aluno → encarregado → informações → documentos → rever
 *                   (cada passo grava sozinho; "continuar" valida o passo; submeter valida tudo)
 *   versão          o processo usa a versão do formulário com que começou (publicar não o muda)
 *   condições       um campo condicional só conta (e só é obrigatório) quando a condição se cumpre
 * A maioridade decide-se AQUI, pela data de hoje em Luanda — nunca pelo navegador.
 */
import { EmailAddress, FullName, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import { ageOn, isAdult } from "../../family/domain/family";
import type { FieldType, FormSnapshot, SnapshotField, SnapshotFixedField, SnapshotSection } from "./forms";
import { PROVINCES } from "../../../../../../libs/kernel/src/domain/angola";

export const APPLICATION_STATUS = {
  DRAFT: "Rascunho",
  SUBMITTED: "Submetida",
  UNDER_REVIEW: "Em análise",
  CORRECTION_REQUIRED: "Correções pedidas",
  APPROVED: "Aprovada",
  REJECTED: "Rejeitada",
  CANCELLED: "Cancelada",
} as const;
export type ApplicationStatus = keyof typeof APPLICATION_STATUS;

/** Processos que a família inicia pela inscrição online (a renovação tem fluxo próprio). */
export const ONLINE_PROCESSES = ["NOVA", "TRANSFERENCIA", "REINGRESSO"] as const;
export type OnlineProcess = (typeof ONLINE_PROCESSES)[number];
export const isOnlineProcess = (p: unknown): p is OnlineProcess => typeof p === "string" && (ONLINE_PROCESSES as readonly string[]).includes(p);

export const SHIFTS = { MANHA: "Manhã", TARDE: "Tarde", NOITE: "Noite" } as const;
export type Shift = keyof typeof SHIFTS;
export const isShift = (s: unknown): s is Shift => typeof s === "string" && s in SHIFTS;

export const STEPS = {
  candidatura: "Candidatura",
  aluno: "Aluno",
  encarregado: "Encarregado",
  informacoes: "Outras informações",
  documentos: "Documentos",
  revisao: "Rever e submeter",
} as const;
export type StepKey = keyof typeof STEPS;
export const isStepKey = (s: unknown): s is StepKey => typeof s === "string" && s in STEPS;

/** Os passos deste formulário (sem secções do colégio ou sem documentos, esses passos não aparecem). */
export function stepsFor(form: FormSnapshot): StepKey[] {
  return (Object.keys(STEPS) as StepKey[]).filter((k) => (k === "informacoes" ? form.sections.length > 0 : k === "documentos" ? form.documents.length > 0 : true));
}

export type Value = string | number | boolean | string[];
export type Entry = Record<string, Value>;
export type Errors = Record<string, string>;

export interface FileRef {
  id: string;
  slot: "PHOTO" | "DOCUMENT" | "FIELD";
  itemId: string | null;
}

export interface CheckContext {
  countryCode: string;
  /** "AAAA-MM-DD" de hoje (Luanda) */
  today: string;
  files: FileRef[];
  /** quem inscreve: encarregado (educando menor) ou o próprio aluno maior */
  accountKind: "GUARDIAN" | "STUDENT";
}

// ================================================================ valores

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string) {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 1900 && +m[1] <= 2100;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const asText = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const TEXT_MAX: Partial<Record<FieldType, number>> = { TEXT: 200, LONG_TEXT: 4000, EMAIL: 254, PHONE: 30, DATE: 10, NUMBER: 30 };

/** Valor normalizado de um campo (ou undefined = vazio) e o erro de formato. O que tem erro fica como texto (não se perde). */
function normalize(f: { type: FieldType; options?: readonly string[]; settings?: { min?: number | null; max?: number | null } }, raw: unknown, ctx: { countryCode: string; fileIds?: Set<string> }): { value?: Value; error?: string } {
  if (isEmpty(raw)) return {};
  switch (f.type) {
    case "BOOLEAN":
      return typeof raw === "boolean" ? { value: raw } : { error: "Responda sim ou não." };
    case "MULTI_SELECT": {
      if (!Array.isArray(raw)) return { error: "Escolha uma ou mais opções." };
      const valid = [...new Set(raw.filter((x): x is string => typeof x === "string"))].filter((x) => f.options?.includes(x));
      return valid.length ? { value: valid } : {};
    }
    case "SELECT": {
      const s = asText(raw);
      return s && f.options?.includes(s) ? { value: s } : { error: "Escolha uma das opções." };
    }
    case "FILE": {
      const s = asText(raw);
      return s && ctx.fileIds?.has(s) ? { value: s } : {};
    }
    default:
  }
  const text = asText(raw);
  if (text === null) return { error: "Valor inválido." };
  const max = TEXT_MAX[f.type] ?? 200;
  const v = f.type === "LONG_TEXT" ? text.trim() : clean(text);
  if (!v) return {};
  if (v.length > max) return { value: v.slice(0, max), error: `No máximo ${max} caracteres.` };
  switch (f.type) {
    case "NUMBER": {
      const n = Number(v.replace(",", "."));
      if (!Number.isFinite(n)) return { value: v, error: "Escreva um número." };
      if (f.settings?.min != null && n < f.settings.min) return { value: n, error: `O mínimo é ${f.settings.min}.` };
      if (f.settings?.max != null && n > f.settings.max) return { value: n, error: `O máximo é ${f.settings.max}.` };
      return { value: n };
    }
    case "DATE":
      return isIsoDate(v) ? { value: v } : { value: v, error: "Data inválida." };
    case "EMAIL": {
      const e = EmailAddress.create(v);
      return e.ok ? { value: e.value.value } : { value: v, error: "Email inválido." };
    }
    case "PHONE": {
      const p = PhoneNumber.create(v, ctx.countryCode);
      return p.ok ? { value: p.value.value } : { value: v, error: "Número de telefone inválido." };
    }
    default:
      return { value: v };
  }
}

/** Texto de um valor para comparar com uma condição ("Sim"/"Não" nos de sim/não). */
const conditionText = (v: Value | undefined) => (v === true ? "Sim" : v === false ? "Não" : typeof v === "string" ? v : null);

// ================================================================ dados fixos (aluno e encarregado)

const ID_DOC = /^[0-9A-Z]{6,20}$/;

function fixedRule(scope: "STUDENT" | "GUARDIAN", key: string, v: Value, data: Entry, ctx: CheckContext): string | null {
  const s = String(v);
  switch (key) {
    case "fullName": {
      const n = FullName.create(s);
      return n.ok ? null : n.error.message;
    }
    case "nationality":
    case "birthplace":
    case "municipality":
    case "neighborhood":
    case "profession":
    case "workplace":
      return s.length < 2 || s.length > 80 ? "Entre 2 e 80 caracteres." : null;
    case "address":
      return s.length < 3 ? "Escreva o endereço completo." : null;
    case "relationshipOther":
      return s.length < 2 || s.length > 60 ? "Entre 2 e 60 caracteres." : null;
    case "idNumber":
    case "nif":
      return ID_DOC.test(s) ? null : "Só letras e algarismos (6 a 20).";
    case "birthDate": {
      if (s > ctx.today) return "A data de nascimento não pode ser no futuro.";
      const age = ageOn(s, ctx.today);
      if (age > 100) return "Data de nascimento inválida.";
      if (scope === "GUARDIAN") return age < 18 ? "O encarregado de educação tem de ser maior de idade." : null;
      // o encarregado inscreve educandos MENORES; o aluno maior inscreve-se a si próprio (com a sua conta)
      if (ctx.accountKind === "GUARDIAN" && isAdult(s, ctx.today)) return "O aluno já tem 18 anos: tem de criar a sua própria conta (aluno maior de idade) e fazer ele a inscrição.";
      return null;
    }
    case "idIssuedOn":
      return s > ctx.today ? "A data de emissão não pode ser no futuro." : null;
    case "idExpiresOn":
      return typeof data.idIssuedOn === "string" && isIsoDate(data.idIssuedOn) && s <= data.idIssuedOn ? "A validade tem de ser depois da emissão." : null;
    case "province":
    case "birthProvince":
      return (PROVINCES as readonly string[]).includes(s) ? null : "Escolha a província.";
    default:
      return null;
  }
}

/** O campo fixo aparece? (showWhen: só com um valor de outro campo fixo) */
const fixedVisible = (f: SnapshotFixedField, data: Entry) => !f.showWhen || f.showWhen.values.includes(conditionText(data[f.showWhen.key]) ?? "");

/**
 * Dados do aluno ou do encarregado. `strict` = continuar/submeter (exige os obrigatórios).
 * A fotografia (campo de ficheiro "photo") entrega-se à parte; aqui só se confirma.
 * `studentAdult`: o aluno é maior (os "obrigatório se maior" passam a obrigatórios).
 */
export function checkFixed(scope: "STUDENT" | "GUARDIAN", fields: SnapshotFixedField[], raw: unknown, strict: boolean, ctx: CheckContext & { studentAdult?: boolean }): { value: Entry; errors: Errors } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value: Entry = {};
  const errors: Errors = {};
  const dataFields = fields.filter((f) => f.type !== "FILE");
  for (const f of dataFields) {
    let r = input[f.key];
    if (typeof r === "string" && (f.key === "idNumber" || f.key === "nif")) r = r.replace(/[\s.-]/g, "").toUpperCase();
    const n = normalize(f, r, { countryCode: ctx.countryCode });
    if (n.value !== undefined) value[f.key] = n.value;
    if (n.error) errors[f.key] = n.error;
  }
  for (const f of dataFields) {
    if (!fixedVisible(f, value)) {
      delete value[f.key];
      delete errors[f.key];
      continue;
    }
    if (errors[f.key]) continue;
    const v = value[f.key];
    const required = f.mode === "REQUIRED" || (scope === "STUDENT" && !!f.adultRequired && !!ctx.studentAdult);
    if (v === undefined) {
      if (strict && required) errors[f.key] = "Obrigatório.";
      continue;
    }
    const e = fixedRule(scope, f.key, v, value, ctx);
    if (e) errors[f.key] = e;
  }
  const photo = fields.find((f) => f.type === "FILE");
  if (strict && photo && photo.mode === "REQUIRED" && !ctx.files.some((x) => x.slot === "PHOTO")) errors[photo.key] = "Envie a fotografia.";
  return { value, errors };
}

/** O encarregado tem algum dado preenchido? (num aluno maior, a parte do encarregado é opcional) */
export const hasGuardianData = (data: unknown) => !!data && typeof data === "object" && Object.values(data as Record<string, unknown>).some((v) => !isEmpty(v));

// ================================================================ secções do colégio

/** O campo aparece neste registo? (condição sobre um campo anterior da mesma secção) */
const fieldVisible = (f: SnapshotField, entry: Entry) => !f.condition || f.condition.values.includes(conditionText(entry[f.condition.fieldId]) ?? "");

/** Uma secção: lista de registos (um só quando não é repetível). Erros por "índice.idDoCampo". */
export function checkSection(section: SnapshotSection, raw: unknown, strict: boolean, ctx: CheckContext): { value: Entry[]; errors: Errors } {
  const list = Array.isArray(raw) ? raw : [];
  const max = section.repeatable ? section.maxEntries : 1;
  const errors: Errors = {};
  if (list.length > max) errors._entries = section.repeatable ? `No máximo ${max} registos.` : "Só um registo.";
  const value: Entry[] = [];
  list.slice(0, max).forEach((item, i) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const entry: Entry = {};
    for (const f of section.fields) {
      const fileIds = new Set(ctx.files.filter((d) => d.slot === "FIELD" && d.itemId === f.id).map((d) => d.id));
      const n = normalize(f, input[f.id], { countryCode: ctx.countryCode, fileIds });
      if (n.value !== undefined) entry[f.id] = n.value;
      if (n.error) errors[`${i}.${f.id}`] = n.error;
    }
    // os campos escondidos pela condição não contam (nem são guardados)
    for (const f of section.fields) {
      if (!fieldVisible(f, entry)) {
        delete entry[f.id];
        delete errors[`${i}.${f.id}`];
      } else if (strict && f.required && entry[f.id] === undefined && !errors[`${i}.${f.id}`]) errors[`${i}.${f.id}`] = "Obrigatório.";
    }
    value.push(entry);
  });
  if (!strict) while (value.length > 0 && Object.keys(value[value.length - 1]).length === 0) value.pop();
  if (strict && value.length === 0 && section.fields.some((f) => f.required && !f.condition)) {
    errors._entries = section.repeatable ? `Acrescente pelo menos um registo (${section.entryLabel.toLowerCase()}).` : "Preencha os dados pedidos.";
  }
  return { value, errors };
}

/** As secções todas (por id da secção). */
export function checkSections(form: FormSnapshot, raw: unknown, strict: boolean, ctx: CheckContext): { value: Record<string, Entry[]>; errors: Record<string, Errors> } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value: Record<string, Entry[]> = {};
  const errors: Record<string, Errors> = {};
  for (const s of form.sections) {
    const r = checkSection(s, input[s.id], strict, ctx);
    if (r.value.length) value[s.id] = r.value;
    if (Object.keys(r.errors).length) errors[s.id] = r.errors;
  }
  return { value, errors };
}

// ================================================================ documentos

/** Documentos obrigatórios em falta. Os do encarregado só contam quando há encarregado (o aluno maior pode não indicar). */
export function checkDocuments(form: FormSnapshot, files: FileRef[], withGuardian: boolean): Errors {
  const errors: Errors = {};
  for (const d of form.documents) {
    if (!d.required) continue;
    if (d.target === "GUARDIAN" && !withGuardian) continue;
    if (!files.some((x) => x.slot === "DOCUMENT" && x.itemId === d.id)) errors[d.id] = "Documento obrigatório.";
  }
  return errors;
}

/** N.º do processo: INS-<ano>-<sequência com 5 algarismos>. */
export const formatApplicationNumber = (year: string, seq: number) => `INS-${year.slice(0, 4)}-${String(seq).padStart(5, "0")}`;
