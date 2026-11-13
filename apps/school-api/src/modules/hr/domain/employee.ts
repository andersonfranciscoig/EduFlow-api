import { PROVINCES } from "../../../../../../libs/kernel/src/domain/angola";
import { EmailAddress, FullName, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import type { FieldType, FileFormat, FormSnapshot, SectionKey, SnapshotField, SnapshotSection } from "./form";

/**
 * CADASTRO DE FUNCIONÁRIO.
 *   estados     DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE ⇄ SUSPENDED → TERMINATED
 *                         ↘ CORRECTION_REQUIRED (volta ao funcionário)   ↘ REJECTED
 *   passos      dados pessoais → formação → profissional → documentos → rever
 *               (formação/profissional/documentos só quando a versão tem algo para o tipo)
 *   valores     validados contra a versão do formulário com que o cadastro começou.
 *               A gravação automática aceita o que ainda está incompleto (e diz o que falta);
 *               concluir um passo e submeter exigem tudo certo.
 */

export type EmployeeStatus = "DRAFT" | "PENDING_APPROVAL" | "CORRECTION_REQUIRED" | "APPROVED" | "REJECTED" | "ACTIVE" | "SUSPENDED" | "TERMINATED";
export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = {
  DRAFT: "Em preenchimento",
  PENDING_APPROVAL: "Por analisar",
  CORRECTION_REQUIRED: "Correções pedidas",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  ACTIVE: "Ativo",
  SUSPENDED: "Suspenso",
  TERMINATED: "Desligado",
};
export const EMPLOYEE_STATUSES = Object.keys(EMPLOYEE_STATUS_LABELS) as EmployeeStatus[];
export const isEmployeeStatus = (s: string): s is EmployeeStatus => s in EMPLOYEE_STATUS_LABELS;

/** Quem preenche pode alterar os dados nestes estados (o RH pode sempre, exceto desligados). */
export const APPLICANT_EDITABLE: EmployeeStatus[] = ["DRAFT", "CORRECTION_REQUIRED"];
export const SUBMITTABLE: EmployeeStatus[] = ["DRAFT", "CORRECTION_REQUIRED"];

/** Vínculo: o que o RH pode fazer depois de aprovar (a aprovação NÃO ativa o vínculo). */
export const EMPLOYMENT_TRANSITIONS: Record<"ACTIVE" | "SUSPENDED" | "TERMINATED", EmployeeStatus[]> = {
  ACTIVE: ["APPROVED", "SUSPENDED"],
  SUSPENDED: ["ACTIVE"],
  TERMINATED: ["ACTIVE", "SUSPENDED", "APPROVED"],
};

export type Progress = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED";

export type StepKey = "personal" | "academic" | "professional" | "documents";
export const STEP_KEYS: StepKey[] = ["personal", "academic", "professional", "documents"];
export const isStepKey = (s: string): s is StepKey => (STEP_KEYS as string[]).includes(s);
export const STEP_SECTION: Record<"academic" | "professional", SectionKey> = { academic: "ACADEMIC", professional: "PROFESSIONAL" };
export const STEP_LABELS: Record<StepKey, string> = { personal: "Dados pessoais", academic: "Formação académica", professional: "Dados profissionais", documents: "Documentos" };

/** Os passos desta versão (já filtrada pelo tipo de funcionário). */
export function stepsFor(form: FormSnapshot): StepKey[] {
  const has = (k: SectionKey) => form.sections.some((s) => s.key === k && s.fields.length > 0);
  return [
    "personal",
    ...(has("ACADEMIC") ? (["academic"] as const) : []),
    ...(has("PROFESSIONAL") ? (["professional"] as const) : []),
    ...(form.documents.length ? (["documents"] as const) : []),
  ];
}

export type Value = string | number | boolean | string[];
export type Entry = Record<string, Value>;
export type PersonalData = Record<string, string>;
export type SectionsData = Partial<Record<SectionKey, Entry[]>>;

/** Ficheiro já entregue (para validar campos de ficheiro e documentos obrigatórios). */
export interface DocRef {
  id: string;
  slot: "PHOTO" | "DOCUMENT" | "FIELD";
  itemId: string | null;
}

export type Errors = Record<string, string>;

export interface CheckContext {
  countryCode: string;
  /** "AAAA-MM-DD" (hora de Luanda) */
  today: string;
  docs: DocRef[];
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

/** Anos completos entre duas datas ISO. */
function age(birth: string, today: string) {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Texto de um valor recebido (só strings e números contam como texto). */
const asText = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

const TEXT_MAX: Partial<Record<FieldType, number>> = { TEXT: 200, LONG_TEXT: 4000, EMAIL: 254, PHONE: 30, DATE: 10, NUMBER: 30 };

/**
 * Normaliza um valor de um campo. Devolve o valor a guardar (ou undefined = vazio) e o erro de formato.
 * Um valor com erro de formato fica guardado como texto (não se perde o que a pessoa escreveu).
 */
function normalize(
  f: { type: FieldType; options?: readonly string[]; settings?: { min?: number | null; max?: number | null } },
  raw: unknown,
  ctx: { countryCode: string; fileIds?: Set<string> },
): { value?: Value; error?: string } {
  if (isEmpty(raw)) return {};
  switch (f.type) {
    case "BOOLEAN":
      return typeof raw === "boolean" ? { value: raw } : { error: "Responda sim ou não." };
    case "MULTI_SELECT": {
      if (!Array.isArray(raw)) return { error: "Escolha uma ou mais opções." };
      const picked = [...new Set(raw.filter((x): x is string => typeof x === "string"))];
      const valid = picked.filter((x) => f.options?.includes(x));
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

// ================================================================ dados pessoais

const ID_DOC = /^[0-9A-Z]{6,20}$/;

/** Regras próprias de cada dado pessoal (além do tipo). */
function personalRule(key: string, v: Value, data: PersonalData, today: string): string | null {
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
      return s.length < 2 || s.length > 80 ? "Entre 2 e 80 caracteres." : null;
    case "address":
      return s.length < 3 ? "Escreva o endereço completo." : null;
    case "idNumber":
    case "nif":
      return ID_DOC.test(s) ? null : "Só letras e algarismos (6 a 20).";
    case "birthDate": {
      const a = age(s, today);
      return a < 16 ? "Tem de ter pelo menos 16 anos." : a > 100 ? "Data de nascimento inválida." : null;
    }
    case "idIssuedOn":
      return s > today ? "A data de emissão não pode ser no futuro." : null;
    case "idExpiresOn":
      return data.idIssuedOn && isIsoDate(data.idIssuedOn) && s <= data.idIssuedOn ? "A validade tem de ser depois da emissão." : null;
    case "province":
      return (PROVINCES as readonly string[]).includes(s) ? null : "Escolha a província.";
    default:
      return null;
  }
}

const PERSONAL_FIELD_DEFS = (form: FormSnapshot) => form.personal.filter((f) => f.key !== "photo");

/**
 * Dados pessoais. `strict` = concluir o passo / submeter (exige os obrigatórios e a fotografia).
 * As chaves desconhecidas são ignoradas.
 */
export function checkPersonal(form: FormSnapshot, raw: unknown, strict: boolean, ctx: CheckContext): { value: PersonalData; errors: Errors } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const value: PersonalData = {};
  const errors: Errors = {};
  for (const f of PERSONAL_FIELD_DEFS(form)) {
    let r = input[f.key];
    if (typeof r === "string" && (f.key === "idNumber" || f.key === "nif")) r = r.replace(/[\s.-]/g, "").toUpperCase();
    const n = normalize(f, r, { countryCode: ctx.countryCode });
    if (n.value !== undefined) value[f.key] = String(n.value);
    if (n.error) errors[f.key] = n.error;
  }
  for (const f of PERSONAL_FIELD_DEFS(form)) {
    if (errors[f.key]) continue;
    const v = value[f.key];
    if (v === undefined) {
      if (strict && f.required) errors[f.key] = "Obrigatório.";
      continue;
    }
    const e = personalRule(f.key, v, value, ctx.today);
    if (e) errors[f.key] = e;
  }
  const photo = form.personal.find((f) => f.key === "photo");
  if (strict && photo?.required && !ctx.docs.some((d) => d.slot === "PHOTO")) errors.photo = "Envie a fotografia.";
  return { value, errors };
}

// ================================================================ secções configuradas

/** Uma secção (formação ou profissional): lista de registos (um só quando não é repetível). */
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
      const fileIds = new Set(ctx.docs.filter((d) => d.slot === "FIELD" && d.itemId === f.id).map((d) => d.id));
      const n = normalize(f, input[f.id], { countryCode: ctx.countryCode, fileIds });
      if (n.value !== undefined) entry[f.id] = n.value;
      if (n.error) errors[`${i}.${f.id}`] = n.error;
      else if (strict && f.required && n.value === undefined) errors[`${i}.${f.id}`] = "Obrigatório.";
    }
    value.push(entry);
  });
  // um registo vazio no fim (ex.: "acrescentar" sem preencher) não conta
  while (value.length > 0 && Object.keys(value[value.length - 1]).length === 0 && !strict) value.pop();
  if (strict) {
    const needs = section.fields.some((f) => f.required);
    if (needs && value.length === 0) errors._entries = `Acrescente pelo menos ${section.repeatable ? `um registo (${section.entryLabel.toLowerCase()})` : "os dados pedidos"}.`;
    // em modo estrito um registo totalmente vazio é erro (se houver campos obrigatórios já foi apanhado)
  }
  return { value, errors };
}

/** Documentos obrigatórios em falta (os ficheiros entram um a um; aqui só se confirma). */
export function checkDocuments(form: FormSnapshot, docs: DocRef[]): Errors {
  const errors: Errors = {};
  for (const d of form.documents) {
    if (d.required && !docs.some((x) => x.slot === "DOCUMENT" && x.itemId === d.id)) errors[d.id] = "Documento obrigatório.";
  }
  return errors;
}

/** Tudo o que falta ou está errado, por passo (submeter exige zero). */
export function checkAll(form: FormSnapshot, data: { personal: unknown; sections: SectionsData }, ctx: CheckContext): Partial<Record<StepKey, Errors>> {
  const out: Partial<Record<StepKey, Errors>> = {};
  const add = (k: StepKey, e: Errors) => {
    if (Object.keys(e).length) out[k] = e;
  };
  add("personal", checkPersonal(form, data.personal, true, ctx).errors);
  for (const step of ["academic", "professional"] as const) {
    const s = form.sections.find((x) => x.key === STEP_SECTION[step]);
    if (s?.fields.length) add(step, checkSection(s, data.sections[s.key] ?? [], true, ctx).errors);
  }
  add("documents", checkDocuments(form, ctx.docs));
  return out;
}

// ================================================================ ficheiros

export const FORMAT_MIME: Record<FileFormat, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const PHOTO_FORMATS: FileFormat[] = ["jpg", "png", "webp"];
export const PHOTO_MAX_MB = 5;
export const MB = 1024 * 1024;

/** O formato real do ficheiro pelos primeiros bytes (a extensão e o tipo enviados não contam). */
export function sniffFormat(content: Buffer, fileName: string): FileFormat | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => content[i] === b);
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (content.subarray(0, 4).toString("latin1") === "RIFF" && content.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "doc";
  // .docx é um zip: só aceitamos com o nome .docx e a estrutura do Word lá dentro
  if (starts(0x50, 0x4b, 0x03, 0x04) && /\.docx$/i.test(fileName) && content.includes(Buffer.from("word/"))) return "docx";
  return null;
}

/** Nome do ficheiro sem caminhos nem caracteres de controlo (fica só na BD). */
export function safeFileName(raw: string, format: FileFormat) {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .trim()
    .slice(0, 180);
  return base || `ficheiro.${format}`;
}

// ================================================================ número e resumo

/** N.º de funcionário como aparece (ex.: 0007). */
export const formatEmployeeNumber = (n: number | null) => (n ? String(n).padStart(4, "0") : null);

/** Cargo e departamento: dos dados profissionais, se o colégio tiver campos com esses nomes. */
export function adminFromProfessional(form: FormSnapshot, sections: SectionsData) {
  const s = form.sections.find((x) => x.key === "PROFESSIONAL");
  const first = sections.PROFESSIONAL?.[0];
  const pick = (re: RegExp) => {
    const f: SnapshotField | undefined = s?.fields.find((x) => re.test(x.label.trim()) && (x.type === "TEXT" || x.type === "SELECT"));
    const v = f && first?.[f.id];
    return typeof v === "string" && v ? v.slice(0, 120) : null;
  };
  return { jobTitle: pick(/^(cargo|função|funcao|categoria profissional)$/i), department: pick(/^(departamento|área|area|setor|sector)$/i) };
}

/** "AAAA-MM-DD" de hoje em Luanda. */
export const luandaToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
