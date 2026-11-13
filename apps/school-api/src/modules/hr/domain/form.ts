import { PROVINCES } from "../../../../../../libs/kernel/src/domain/angola";
import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * CADASTRO DE FUNCIONÁRIOS — configuração do formulário.
 *   tipos             de funcionário (Docente, Administrativo, Auxiliar…): cada cadastro é de um tipo
 *   dados pessoais    fixos, iguais em todos os colégios e tipos (definidos aqui)
 *   secções           formação académica e dados profissionais: campos escolhidos pelo colégio
 *   documentos        o que o colégio pede (formatos, tamanho, um ou vários ficheiros)
 *   "aplica-se a"     cada campo e documento vale para todos os tipos ou só para alguns
 *   versões           o colégio publica a configuração; cada cadastro fica com a sua versão
 */

export type HrErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "SECTION_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "FIELD_EXISTS"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_EXISTS"
  | "LIMIT_REACHED"
  | "NOTHING_TO_PUBLISH"
  | "EMPLOYEE_TYPE_NOT_FOUND"
  | "EMPLOYEE_TYPE_EXISTS"
  | "EMPLOYEE_TYPE_IN_USE"
  | "VERSION_NOT_FOUND"
  // pedidos de cadastro e convites
  | "REQUEST_NOT_FOUND"
  | "INVALID_STATE"
  | "FORM_NOT_PUBLISHED"
  | "EMAIL_NOT_SENT"
  // formulário pelo convite e cadastros
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_LOCKED"
  | "INVALID_CREDENTIALS"
  | "SESSION_EXPIRED"
  | "EMPLOYEE_NOT_FOUND"
  | "STEP_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INCOMPLETE"
  | "FILE_INVALID"
  | "FILE_TOO_LARGE"
  | "FILE_NOT_FOUND"
  | "STORAGE_NOT_CONFIGURED"
  | "STORAGE_UNAVAILABLE";

export type HrError = DomainError<HrErrorCode>;
export const hrError = (code: HrErrorCode, message: string, meta?: Record<string, unknown>): HrError => new DomainError(code, message, meta);

// ================================================================ tipos de campo

export const FIELD_TYPES = {
  TEXT: { label: "Texto curto", hint: "Uma linha (ex.: curso, instituição)." },
  LONG_TEXT: { label: "Texto longo", hint: "Vários parágrafos (ex.: outras qualificações)." },
  NUMBER: { label: "Número", hint: "Só algarismos, com mínimo e máximo opcionais." },
  DATE: { label: "Data", hint: "Dia, mês e ano (ex.: data de admissão)." },
  EMAIL: { label: "Email", hint: "Endereço de email válido." },
  PHONE: { label: "Telefone", hint: "Número de telefone." },
  SELECT: { label: "Escolha única", hint: "Uma opção de uma lista (ex.: nível académico)." },
  MULTI_SELECT: { label: "Escolha múltipla", hint: "Várias opções de uma lista." },
  BOOLEAN: { label: "Sim / Não", hint: "Uma pergunta de sim ou não." },
  FILE: { label: "Ficheiro", hint: "Um ficheiro anexado a esta resposta." },
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export const isFieldType = (t: string): t is FieldType => t in FIELD_TYPES;

export const SECTION_KEYS = ["ACADEMIC", "PROFESSIONAL"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export const isSectionKey = (k: string): k is SectionKey => (SECTION_KEYS as readonly string[]).includes(k);

export const FILE_FORMATS = ["pdf", "jpg", "png", "webp", "doc", "docx"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];
export const MAX_FIELDS_PER_SECTION = 40;
export const MAX_DOCUMENT_TYPES = 30;
export const MAX_EMPLOYEE_TYPES = 20;

// ================================================================ dados pessoais (fixos)

export interface PersonalField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: readonly string[];
  help?: string;
}

/** Iguais em todos os colégios e tipos: não se configuram. A validação de cada valor vem com o formulário. */
export const PERSONAL_FIELDS: PersonalField[] = [
  { key: "fullName", label: "Nome completo", type: "TEXT", required: true },
  { key: "gender", label: "Sexo", type: "SELECT", required: true, options: ["Masculino", "Feminino"] },
  { key: "birthDate", label: "Data de nascimento", type: "DATE", required: true },
  { key: "nationality", label: "Nacionalidade", type: "TEXT", required: true },
  { key: "birthplace", label: "Naturalidade", type: "TEXT", required: true },
  { key: "maritalStatus", label: "Estado civil", type: "SELECT", required: true, options: ["Solteiro(a)", "Casado(a)", "União de facto", "Divorciado(a)", "Viúvo(a)"] },
  { key: "idNumber", label: "N.º do Bilhete de Identidade", type: "TEXT", required: true, help: "Ex.: 004512345LA041" },
  { key: "idIssuedOn", label: "Data de emissão do BI", type: "DATE", required: true },
  { key: "idExpiresOn", label: "Data de validade do BI", type: "DATE", required: true },
  { key: "nif", label: "NIF", type: "TEXT", required: false, help: "Número de Identificação Fiscal (se diferente do BI)." },
  { key: "phone", label: "Telefone", type: "PHONE", required: true },
  { key: "email", label: "Email", type: "EMAIL", required: true },
  { key: "province", label: "Província", type: "SELECT", required: true, options: PROVINCES },
  { key: "municipality", label: "Município", type: "TEXT", required: true },
  { key: "neighborhood", label: "Bairro", type: "TEXT", required: true },
  { key: "address", label: "Endereço de residência", type: "TEXT", required: true },
  { key: "photo", label: "Fotografia", type: "FILE", required: true, help: "Tipo passe, fundo claro (JPG, PNG ou WEBP até 5 MB)." },
];
/** Versão da estrutura dos dados pessoais (muda só com o código). */
export const PERSONAL_SCHEMA = 1;

// ================================================================ validação da configuração

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || "";
const optional = (s: string | null | undefined) => clean(s) || null;

/** A que tipos se aplica: lista sem repetidos (vazia = todos). Que os tipos existem confirma-se no caso de uso. */
export const cleanTypeIds = (ids: string[] | null | undefined) => [...new Set((ids ?? []).filter(Boolean))];

/** Um campo ou documento aparece a este tipo? (sem lista = a todos) */
export const appliesTo = (item: { employeeTypeIds?: string[] }, typeId: string) => !item.employeeTypeIds?.length || item.employeeTypeIds.includes(typeId);

export interface EmployeeTypeInput {
  name: string;
  description: string | null;
}

export function checkEmployeeType(input: { name: string; description?: string | null }): Result<EmployeeTypeInput, HrError> {
  const name = clean(input.name);
  if (name.length < 2 || name.length > 60) return fail(hrError("INVALID_INPUT", "O nome do tipo tem 2 a 60 caracteres."));
  const description = optional(input.description);
  if (description && description.length > 240) return fail(hrError("INVALID_INPUT", "A descrição tem no máximo 240 caracteres."));
  return ok({ name, description });
}

export interface FieldSettings {
  /** FILE */
  formats?: FileFormat[];
  maxSizeMb?: number;
  /** NUMBER */
  min?: number | null;
  max?: number | null;
}

export interface FieldInput {
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  options: string[];
  settings: FieldSettings;
  /** tipos de funcionário (vazio = todos) */
  employeeTypeIds: string[];
}

export function checkField(input: {
  label: string;
  type: string;
  required?: boolean;
  help?: string | null;
  options?: string[] | null;
  settings?: FieldSettings | null;
  employeeTypeIds?: string[] | null;
}): Result<FieldInput, HrError> {
  const label = clean(input.label);
  if (label.length < 2 || label.length > 80) return fail(hrError("INVALID_INPUT", "O nome do campo tem 2 a 80 caracteres."));
  if (!isFieldType(input.type)) return fail(hrError("INVALID_INPUT", "Escolha um tipo de campo válido."));
  const help = optional(input.help);
  if (help && help.length > 240) return fail(hrError("INVALID_INPUT", "A instrução tem no máximo 240 caracteres."));

  let options: string[] = [];
  if (input.type === "SELECT" || input.type === "MULTI_SELECT") {
    options = (input.options ?? []).map(clean).filter(Boolean);
    if (options.length < 2) return fail(hrError("INVALID_INPUT", "Uma escolha precisa de pelo menos 2 opções."));
    if (options.length > 40) return fail(hrError("INVALID_INPUT", "No máximo 40 opções."));
    if (options.some((o) => o.length > 80)) return fail(hrError("INVALID_INPUT", "Cada opção tem no máximo 80 caracteres."));
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return fail(hrError("INVALID_INPUT", "Há opções repetidas."));
  }

  const settings: FieldSettings = {};
  if (input.type === "FILE") {
    const s = checkFileRules(input.settings?.formats ?? ["pdf", "jpg", "png"], input.settings?.maxSizeMb ?? 5);
    if (!s.ok) return s;
    Object.assign(settings, s.value);
  }
  if (input.type === "NUMBER") {
    const min = input.settings?.min ?? null;
    const max = input.settings?.max ?? null;
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return fail(hrError("INVALID_INPUT", "Mínimo e máximo têm de ser números."));
    if (min !== null && max !== null && min > max) return fail(hrError("INVALID_INPUT", "O mínimo não pode ser maior do que o máximo."));
    settings.min = min;
    settings.max = max;
  }
  return ok({ label, type: input.type, required: !!input.required, help, options, settings, employeeTypeIds: cleanTypeIds(input.employeeTypeIds) });
}

function checkFileRules(formats: string[], maxSizeMb: number): Result<{ formats: FileFormat[]; maxSizeMb: number }, HrError> {
  const f = [...new Set(formats.map((x) => x.toLowerCase()))];
  if (!f.length) return fail(hrError("INVALID_INPUT", "Escolha pelo menos um formato de ficheiro."));
  if (f.some((x) => !(FILE_FORMATS as readonly string[]).includes(x))) return fail(hrError("INVALID_INPUT", "Formato de ficheiro não suportado."));
  if (!Number.isInteger(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > 20) return fail(hrError("INVALID_INPUT", "O tamanho máximo vai de 1 a 20 MB."));
  return ok({ formats: FILE_FORMATS.filter((x) => f.includes(x)), maxSizeMb });
}

export interface DocumentTypeInput {
  name: string;
  description: string | null;
  required: boolean;
  formats: FileFormat[];
  maxSizeMb: number;
  multiple: boolean;
  /** tipos de funcionário (vazio = todos) */
  employeeTypeIds: string[];
}

export function checkDocumentType(input: {
  name: string;
  description?: string | null;
  required?: boolean;
  formats: string[];
  maxSizeMb: number;
  multiple?: boolean;
  employeeTypeIds?: string[] | null;
}): Result<DocumentTypeInput, HrError> {
  const name = clean(input.name);
  if (name.length < 2 || name.length > 80) return fail(hrError("INVALID_INPUT", "O nome do documento tem 2 a 80 caracteres."));
  const description = optional(input.description);
  if (description && description.length > 240) return fail(hrError("INVALID_INPUT", "A descrição tem no máximo 240 caracteres."));
  const rules = checkFileRules(input.formats, input.maxSizeMb);
  if (!rules.ok) return rules;
  return ok({ name, description, required: !!input.required, ...rules.value, multiple: !!input.multiple, employeeTypeIds: cleanTypeIds(input.employeeTypeIds) });
}

export interface SectionInput {
  title: string;
  description: string | null;
  repeatable: boolean;
  entryLabel: string;
  maxEntries: number;
}

export function checkSection(input: { title: string; description?: string | null; repeatable: boolean; entryLabel: string; maxEntries: number }): Result<SectionInput, HrError> {
  const title = clean(input.title);
  if (title.length < 2 || title.length > 60) return fail(hrError("INVALID_INPUT", "O título tem 2 a 60 caracteres."));
  const description = optional(input.description);
  if (description && description.length > 240) return fail(hrError("INVALID_INPUT", "A descrição tem no máximo 240 caracteres."));
  const entryLabel = clean(input.entryLabel);
  if (entryLabel.length < 2 || entryLabel.length > 40) return fail(hrError("INVALID_INPUT", "O nome de cada registo tem 2 a 40 caracteres."));
  if (!Number.isInteger(input.maxEntries) || input.maxEntries < 1 || input.maxEntries > 20) return fail(hrError("INVALID_INPUT", "O limite de registos vai de 1 a 20."));
  return ok({ title, description, repeatable: !!input.repeatable, entryLabel, maxEntries: input.maxEntries });
}

// ================================================================ sugestões (o colégio escolhe se as quer)

export const SUGGESTED_EMPLOYEE_TYPES: EmployeeTypeInput[] = [
  { name: "Docente", description: "Professores e educadores." },
  { name: "Administrativo", description: "Secretaria, tesouraria, direção e serviços." },
  { name: "Auxiliar", description: "Limpeza, segurança, cozinha, transporte e apoio." },
];

/** `forTypes`: nomes dos tipos a que a sugestão se aplica, se existirem no colégio (senão, a todos). */
type Suggestion = Omit<FieldInput, "help" | "settings" | "employeeTypeIds"> & { help?: string | null; settings?: FieldSettings; forTypes?: string[] };

export const SUGGESTED_FIELDS: Record<SectionKey, Suggestion[]> = {
  ACADEMIC: [
    { label: "Nível académico", type: "SELECT", required: true, options: ["Ensino primário", "Ensino secundário", "Técnico médio", "Bacharelato", "Licenciatura", "Pós-graduação", "Mestrado", "Doutoramento"] },
    { label: "Curso", type: "TEXT", required: true, options: [] },
    { label: "Especialidade", type: "TEXT", required: false, options: [] },
    { label: "Instituição de ensino", type: "TEXT", required: true, options: [] },
    { label: "Ano de conclusão", type: "NUMBER", required: true, options: [], settings: { min: 1950, max: 2100 } },
    { label: "País de formação", type: "TEXT", required: false, options: [] },
    { label: "Tem formação pedagógica?", type: "BOOLEAN", required: true, options: [], forTypes: ["Docente"] },
    { label: "Outras qualificações", type: "LONG_TEXT", required: false, options: [] },
  ],
  PROFESSIONAL: [
    { label: "Cargo", type: "TEXT", required: true, options: [] },
    { label: "Departamento", type: "TEXT", required: false, options: [] },
    { label: "Data de admissão", type: "DATE", required: false, options: [] },
    { label: "Tipo de vínculo", type: "SELECT", required: true, options: ["Efetivo", "Contrato a termo", "Prestação de serviços", "Estágio"] },
    { label: "Regime de trabalho", type: "SELECT", required: false, options: ["Tempo inteiro", "Tempo parcial"] },
    { label: "Carga horária semanal (horas)", type: "NUMBER", required: false, options: [], settings: { min: 1, max: 60 } },
    { label: "Disciplinas que pode lecionar", type: "LONG_TEXT", required: true, options: [], forTypes: ["Docente"] },
    { label: "Experiência de ensino (anos)", type: "NUMBER", required: false, options: [], settings: { min: 0, max: 60 }, forTypes: ["Docente"] },
    { label: "Experiência profissional", type: "LONG_TEXT", required: false, options: [] },
    { label: "Instituição de origem", type: "TEXT", required: false, options: [] },
  ],
};

export const SUGGESTED_DOCUMENTS: (Omit<DocumentTypeInput, "employeeTypeIds"> & { forTypes?: string[] })[] = [
  { name: "Cópia do Bilhete de Identidade", description: "Frente e verso.", required: true, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: true },
  { name: "Curriculum Vitae", description: null, required: true, formats: ["pdf", "doc", "docx"], maxSizeMb: 5, multiple: false },
  { name: "Certificado de habilitações", description: null, required: true, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: true },
  { name: "Diploma", description: null, required: false, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: true },
  { name: "Certificado de formação pedagógica", description: null, required: true, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: false, forTypes: ["Docente"] },
  { name: "Registo criminal", description: "Emitido há menos de 90 dias.", required: false, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: false },
  { name: "Atestado médico", description: null, required: false, formats: ["pdf", "jpg", "png"], maxSizeMb: 5, multiple: false },
];

// ================================================================ versões publicadas

export interface SnapshotField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  options: string[];
  settings: FieldSettings;
  /** só quando o campo não é para todos os tipos */
  employeeTypeIds?: string[];
}

export type SnapshotDocument = { id: string } & Omit<DocumentTypeInput, "employeeTypeIds"> & { employeeTypeIds?: string[] };

export interface SnapshotSection {
  key: SectionKey;
  title: string;
  description: string | null;
  repeatable: boolean;
  entryLabel: string;
  maxEntries: number;
  fields: SnapshotField[];
}

export interface FormSnapshot {
  personalSchema: number;
  personal: PersonalField[];
  /** tipos de funcionário ativos (só quando o colégio os definiu) */
  employeeTypes?: { id: string; name: string; description: string | null }[];
  sections: SnapshotSection[];
  documents: SnapshotDocument[];
}

/**
 * A versão como a vê um funcionário deste tipo: só os campos e documentos que se lhe aplicam.
 * Sem tipo (ou numa versão sem tipos): tudo.
 */
export function forEmployeeType(snapshot: FormSnapshot, typeId: string | null): FormSnapshot {
  if (!typeId) return snapshot;
  return {
    ...snapshot,
    sections: snapshot.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => appliesTo(f, typeId)) })),
    documents: snapshot.documents.filter((d) => appliesTo(d, typeId)),
  };
}

/** Ordem estável das chaves (o JSONB do Postgres reordena-as): compara configuração e versão publicada. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** O que muda entre a versão publicada e a configuração atual (frases para o ecrã de publicar). */
export function describeChanges(from: FormSnapshot | null, to: FormSnapshot): string[] {
  if (!from) return ["Primeira versão do formulário."];
  const out: string[] = [];

  const beforeTypes = new Map((from.employeeTypes ?? []).map((t) => [t.id, t]));
  const afterTypes = new Map((to.employeeTypes ?? []).map((t) => [t.id, t]));
  for (const t of to.employeeTypes ?? []) {
    const old = beforeTypes.get(t.id);
    if (!old) out.push(`Tipos de funcionário: novo “${t.name}”.`);
    else if (canonical(old) !== canonical(t)) out.push(`Tipos de funcionário: “${t.name}” alterado.`);
  }
  for (const t of from.employeeTypes ?? []) if (!afterTypes.has(t.id)) out.push(`Tipos de funcionário: “${t.name}” retirado.`);

  for (const s of to.sections) {
    const prev = from.sections.find((x) => x.key === s.key);
    const before = new Map((prev?.fields ?? []).map((f) => [f.id, f]));
    const after = new Map(s.fields.map((f) => [f.id, f]));
    const lines: string[] = [];
    for (const f of s.fields) {
      const old = before.get(f.id);
      if (!old) lines.push(`${s.title}: novo campo “${f.label}”.`);
      else if (canonical(old) !== canonical(f)) lines.push(`${s.title}: campo “${f.label}” alterado.`);
    }
    for (const f of prev?.fields ?? []) if (!after.has(f.id)) lines.push(`${s.title}: campo “${f.label}” retirado.`);
    // só a ordem mudou (os mesmos campos, iguais)
    const kept = (prev?.fields ?? []).filter((f) => after.has(f.id)).map((f) => f.id);
    const now = s.fields.filter((f) => before.has(f.id)).map((f) => f.id);
    if (!lines.length && kept.join() !== now.join()) lines.push(`${s.title}: nova ordem dos campos.`);
    out.push(...lines);
    if (prev && (prev.title !== s.title || prev.repeatable !== s.repeatable || prev.entryLabel !== s.entryLabel || prev.maxEntries !== s.maxEntries || prev.description !== s.description)) {
      out.push(`${s.title}: definições da secção alteradas.`);
    }
  }
  const beforeDocs = new Map(from.documents.map((d) => [d.id, d]));
  const afterDocs = new Map(to.documents.map((d) => [d.id, d]));
  for (const d of to.documents) {
    const old = beforeDocs.get(d.id);
    if (!old) out.push(`Documentos: novo “${d.name}”.`);
    else if (canonical(old) !== canonical(d)) out.push(`Documentos: “${d.name}” alterado.`);
  }
  for (const d of from.documents) if (!afterDocs.has(d.id)) out.push(`Documentos: “${d.name}” retirado.`);
  if (!out.length && canonical(from) !== canonical(to)) out.push("Nova ordem de campos ou documentos.");
  return out;
}
