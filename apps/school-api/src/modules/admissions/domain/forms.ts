/**
 * INSCRIÇÕES — formulários (configuração, 2.ª parte).
 *   dados fixos     aluno e encarregado: os campos vêm da plataforma. Os ESSENCIAIS são sempre
 *                   obrigatórios; os outros, cada colégio põe obrigatório, opcional ou escondido.
 *                   Aluno maior de idade: telefone e email sempre pedidos (adultRequired).
 *   secções         do colégio (ex.: percurso escolar anterior, informações adicionais), com
 *                   campos de 10 tipos; secção e campo dizem em que processos aparecem (vazio = todos)
 *   condições       um campo pode aparecer só quando outro campo ANTERIOR da mesma secção
 *                   (escolha, escolha múltipla ou sim/não) tem um dos valores indicados
 *   versões         a publicação fotografa dados fixos, secções e documentos; cada inscrição
 *                   fica presa à versão com que começou
 */
import { PROVINCES } from "../../../../../../libs/kernel/src/domain/angola";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type AdmissionError, admissionError, type DocumentTypeInput, FILE_FORMATS, type FileFormat, PROCESS_TYPE_KEYS, PROCESS_TYPES, type ProcessType } from "./settings";

// ================================================================ tipos de campo

export const FIELD_TYPES = {
  TEXT: { label: "Texto curto", hint: "Uma linha (ex.: escola anterior)." },
  LONG_TEXT: { label: "Texto longo", hint: "Vários parágrafos (ex.: motivo da transferência)." },
  NUMBER: { label: "Número", hint: "Só algarismos, com mínimo e máximo opcionais (ex.: média final)." },
  DATE: { label: "Data", hint: "Dia, mês e ano." },
  EMAIL: { label: "Email", hint: "Endereço de email válido." },
  PHONE: { label: "Telefone", hint: "Número de telefone." },
  SELECT: { label: "Escolha única", hint: "Uma opção de uma lista (ex.: classe frequentada)." },
  MULTI_SELECT: { label: "Escolha múltipla", hint: "Várias opções de uma lista." },
  BOOLEAN: { label: "Sim / Não", hint: "Uma pergunta de sim ou não." },
  FILE: { label: "Ficheiro", hint: "Um ficheiro anexado a esta resposta." },
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export const isFieldType = (t: string): t is FieldType => t in FIELD_TYPES;
/** Tipos que podem decidir se outro campo aparece. */
export const CONDITION_SOURCES: FieldType[] = ["SELECT", "MULTI_SELECT", "BOOLEAN"];
export const BOOLEAN_VALUES = ["Sim", "Não"] as const;

export const MAX_SECTIONS = 12;
export const MAX_FIELDS_PER_SECTION = 40;

// ================================================================ dados fixos

export type FixedScope = "STUDENT" | "GUARDIAN";
export type FixedMode = "REQUIRED" | "OPTIONAL" | "HIDDEN";
export const FIXED_MODE_LABELS: Record<FixedMode, string> = { REQUIRED: "Obrigatório", OPTIONAL: "Opcional", HIDDEN: "Não pedir" };

export interface FixedField {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  help?: string;
  /** essencial: sempre obrigatório, o colégio não muda */
  essential?: boolean;
  /** o modo de partida nos campos que o colégio pode mudar */
  defaultMode?: FixedMode;
  /** aluno maior de idade: sempre pedido (é ele o titular da conta) */
  adultRequired?: boolean;
  /** só aparece quando outro campo fixo tem este valor */
  showWhen?: { key: string; values: string[] };
}

export const RELATIONSHIPS = ["Pai", "Mãe", "Avô", "Avó", "Tio", "Tia", "Irmão", "Irmã", "Tutor legal", "Outro"] as const;

export const FIXED_FIELDS: Record<FixedScope, FixedField[]> = {
  STUDENT: [
    { key: "fullName", label: "Nome completo", type: "TEXT", essential: true },
    { key: "gender", label: "Sexo", type: "SELECT", options: ["Masculino", "Feminino"], essential: true },
    { key: "birthDate", label: "Data de nascimento", type: "DATE", essential: true, help: "Decide se o aluno é menor (inscrito pelo encarregado) ou maior de idade." },
    { key: "nationality", label: "Nacionalidade", type: "TEXT", essential: true },
    { key: "birthplace", label: "Naturalidade", type: "TEXT", defaultMode: "REQUIRED" },
    { key: "birthProvince", label: "Província de nascimento", type: "SELECT", options: PROVINCES, defaultMode: "REQUIRED" },
    { key: "idNumber", label: "N.º do Bilhete de Identidade", type: "TEXT", defaultMode: "OPTIONAL", help: "Ex.: 004512345LA041 (crianças podem ainda não ter BI)." },
    { key: "idIssuedOn", label: "Data de emissão do BI", type: "DATE", defaultMode: "OPTIONAL" },
    { key: "idExpiresOn", label: "Data de validade do BI", type: "DATE", defaultMode: "OPTIONAL" },
    { key: "nif", label: "NIF", type: "TEXT", defaultMode: "HIDDEN" },
    { key: "phone", label: "Telefone", type: "PHONE", defaultMode: "OPTIONAL", adultRequired: true },
    { key: "email", label: "Email", type: "EMAIL", defaultMode: "OPTIONAL", adultRequired: true },
    { key: "province", label: "Província de residência", type: "SELECT", options: PROVINCES, essential: true },
    { key: "municipality", label: "Município", type: "TEXT", essential: true },
    { key: "neighborhood", label: "Bairro", type: "TEXT", defaultMode: "REQUIRED" },
    { key: "address", label: "Endereço de residência", type: "TEXT", essential: true },
    { key: "photo", label: "Fotografia", type: "FILE", defaultMode: "REQUIRED", help: "Tipo passe, fundo claro (JPG, PNG ou WEBP até 5 MB)." },
  ],
  GUARDIAN: [
    { key: "fullName", label: "Nome completo", type: "TEXT", essential: true },
    { key: "gender", label: "Sexo", type: "SELECT", options: ["Masculino", "Feminino"], defaultMode: "REQUIRED" },
    { key: "birthDate", label: "Data de nascimento", type: "DATE", defaultMode: "OPTIONAL" },
    { key: "relationship", label: "Grau de parentesco", type: "SELECT", options: RELATIONSHIPS, essential: true },
    { key: "relationshipOther", label: "Qual o grau de parentesco?", type: "TEXT", essential: true, showWhen: { key: "relationship", values: ["Outro"] } },
    { key: "idNumber", label: "N.º do Bilhete de Identidade", type: "TEXT", essential: true },
    { key: "nif", label: "NIF", type: "TEXT", defaultMode: "HIDDEN" },
    { key: "phone", label: "Telefone principal", type: "PHONE", essential: true },
    { key: "phoneAlt", label: "Telefone alternativo", type: "PHONE", defaultMode: "OPTIONAL" },
    { key: "email", label: "Email", type: "EMAIL", essential: true, help: "É com este email que o encarregado entra no portal." },
    { key: "profession", label: "Profissão", type: "TEXT", defaultMode: "OPTIONAL" },
    { key: "workplace", label: "Local de trabalho", type: "TEXT", defaultMode: "OPTIONAL" },
    { key: "province", label: "Província", type: "SELECT", options: PROVINCES, defaultMode: "REQUIRED" },
    { key: "municipality", label: "Município", type: "TEXT", defaultMode: "REQUIRED" },
    { key: "neighborhood", label: "Bairro", type: "TEXT", defaultMode: "OPTIONAL" },
    { key: "address", label: "Endereço de residência", type: "TEXT", defaultMode: "REQUIRED" },
  ],
};

/** Versão da estrutura dos dados fixos (muda só com o código). */
export const FIXED_SCHEMA = 1;

export const fixedField = (scope: FixedScope, key: string) => FIXED_FIELDS[scope].find((f) => f.key === key) ?? null;

/** O modo efetivo de um campo fixo (essencial = sempre obrigatório). */
export const fixedMode = (f: FixedField, overrides: Map<string, FixedMode>): FixedMode => (f.essential ? "REQUIRED" : (overrides.get(f.key) ?? f.defaultMode ?? "OPTIONAL"));

export function checkFixedMode(scope: string, key: string, mode: string): Result<{ scope: FixedScope; key: string; mode: FixedMode }, AdmissionError> {
  if (scope !== "STUDENT" && scope !== "GUARDIAN") return fail(admissionError("INVALID_INPUT", "Secção de dados fixos inválida."));
  const f = fixedField(scope, key);
  if (!f) return fail(admissionError("FIELD_NOT_FOUND", "Campo não encontrado."));
  if (f.essential) return fail(admissionError("INVALID_INPUT", `“${f.label}” é essencial: é sempre pedido.`));
  if (!(mode in FIXED_MODE_LABELS)) return fail(admissionError("INVALID_INPUT", "Escolha obrigatório, opcional ou não pedir."));
  return ok({ scope, key, mode: mode as FixedMode });
}

// ================================================================ secções e campos

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || "";
const optional = (s: string | null | undefined) => clean(s) || null;

/** Processos escolhidos: sem repetidos, por ordem; os 4 = "todos" (vazio). */
export function cleanProcesses(list: string[] | null | undefined): Result<ProcessType[], AdmissionError> {
  const set = [...new Set(list ?? [])];
  if (set.some((p) => !(p in PROCESS_TYPES))) return fail(admissionError("INVALID_INPUT", "Processo inválido."));
  return ok(set.length === PROCESS_TYPE_KEYS.length ? [] : PROCESS_TYPE_KEYS.filter((p) => set.includes(p)));
}

/** Aparece neste processo? (sem lista = em todos) */
export const inProcess = (item: { processTypes: ProcessType[] }, p: ProcessType) => !item.processTypes.length || item.processTypes.includes(p);

export interface SectionInput {
  title: string;
  description: string | null;
  repeatable: boolean;
  entryLabel: string;
  maxEntries: number;
  processTypes: ProcessType[];
}

export function checkSection(input: { title: string; description?: string | null; repeatable: boolean; entryLabel?: string | null; maxEntries?: number; processTypes?: string[] }): Result<SectionInput, AdmissionError> {
  const title = clean(input.title);
  if (title.length < 2 || title.length > 60) return fail(admissionError("INVALID_INPUT", "O título da secção tem 2 a 60 caracteres."));
  const description = optional(input.description);
  if (description && description.length > 240) return fail(admissionError("INVALID_INPUT", "A descrição tem no máximo 240 caracteres."));
  const entryLabel = clean(input.entryLabel) || "Registo";
  if (entryLabel.length < 2 || entryLabel.length > 40) return fail(admissionError("INVALID_INPUT", "O nome de cada registo tem 2 a 40 caracteres."));
  const maxEntries = input.repeatable ? (input.maxEntries ?? 5) : 1;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 20) return fail(admissionError("INVALID_INPUT", "O limite de registos vai de 1 a 20."));
  const processTypes = cleanProcesses(input.processTypes);
  if (!processTypes.ok) return processTypes;
  return ok({ title, description, repeatable: !!input.repeatable, entryLabel, maxEntries, processTypes: processTypes.value });
}

export interface FieldSettings {
  /** FILE */
  formats?: FileFormat[];
  maxSizeMb?: number;
  /** NUMBER */
  min?: number | null;
  max?: number | null;
}

/** Mostrar só quando o campo `fieldId` (anterior, mesma secção) tem um destes valores. */
export interface FieldCondition {
  fieldId: string;
  values: string[];
}

export interface FieldInput {
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  options: string[];
  settings: FieldSettings;
  processTypes: ProcessType[];
  condition: FieldCondition | null;
}

/** Valores possíveis de um campo usado como condição. */
export const conditionValues = (f: { type: FieldType; options: string[] }) => (f.type === "BOOLEAN" ? [...BOOLEAN_VALUES] : f.options);

/**
 * Valida um campo. `siblings` = os outros campos da secção, pela ordem (para a condição:
 * a fonte tem de existir, vir antes deste campo e ser de escolha ou sim/não).
 */
export function checkField(
  input: {
    label: string;
    type: string;
    required?: boolean;
    help?: string | null;
    options?: string[] | null;
    settings?: FieldSettings | null;
    processTypes?: string[] | null;
    condition?: FieldCondition | null;
  },
  ctx: { selfId: string | null; siblings: { id: string; label: string; type: FieldType; options: string[]; position: number }[]; selfPosition: number | null },
): Result<FieldInput, AdmissionError> {
  const label = clean(input.label);
  if (label.length < 2 || label.length > 80) return fail(admissionError("INVALID_INPUT", "A pergunta tem 2 a 80 caracteres."));
  if (!isFieldType(input.type)) return fail(admissionError("INVALID_INPUT", "Escolha um tipo de campo válido."));
  const help = optional(input.help);
  if (help && help.length > 240) return fail(admissionError("INVALID_INPUT", "A instrução tem no máximo 240 caracteres."));

  let options: string[] = [];
  if (input.type === "SELECT" || input.type === "MULTI_SELECT") {
    options = (input.options ?? []).map(clean).filter(Boolean);
    if (options.length < 2) return fail(admissionError("INVALID_INPUT", "Uma escolha precisa de pelo menos 2 opções."));
    if (options.length > 40) return fail(admissionError("INVALID_INPUT", "No máximo 40 opções."));
    if (options.some((o) => o.length > 80)) return fail(admissionError("INVALID_INPUT", "Cada opção tem no máximo 80 caracteres."));
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return fail(admissionError("INVALID_INPUT", "Há opções repetidas."));
  }

  const settings: FieldSettings = {};
  if (input.type === "FILE") {
    const formats = FILE_FORMATS.filter((f) => (input.settings?.formats ?? ["pdf", "jpg", "png"]).includes(f));
    const maxSizeMb = input.settings?.maxSizeMb ?? 5;
    if (!formats.length) return fail(admissionError("INVALID_INPUT", "Escolha pelo menos um formato de ficheiro."));
    if (!Number.isInteger(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > 20) return fail(admissionError("INVALID_INPUT", "O tamanho máximo vai de 1 a 20 MB."));
    Object.assign(settings, { formats, maxSizeMb });
  }
  if (input.type === "NUMBER") {
    const min = input.settings?.min ?? null;
    const max = input.settings?.max ?? null;
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return fail(admissionError("INVALID_INPUT", "Mínimo e máximo têm de ser números."));
    if (min !== null && max !== null && min > max) return fail(admissionError("INVALID_INPUT", "O mínimo não pode ser maior do que o máximo."));
    Object.assign(settings, { min, max });
  }

  const processTypes = cleanProcesses(input.processTypes);
  if (!processTypes.ok) return processTypes;

  let condition: FieldCondition | null = null;
  if (input.condition) {
    const src = ctx.siblings.find((s) => s.id === input.condition!.fieldId && s.id !== ctx.selfId);
    if (!src) return fail(admissionError("INVALID_INPUT", "A condição tem de usar outro campo desta secção."));
    if (!CONDITION_SOURCES.includes(src.type)) return fail(admissionError("INVALID_INPUT", `“${src.label}” não decide condições (só escolhas e sim/não).`));
    if (ctx.selfPosition !== null && src.position >= ctx.selfPosition) return fail(admissionError("INVALID_INPUT", `“${src.label}” tem de vir antes deste campo.`));
    const allowed = conditionValues(src);
    const values = [...new Set(input.condition.values)].filter((v) => allowed.includes(v));
    if (!values.length || values.length !== new Set(input.condition.values).size) return fail(admissionError("INVALID_INPUT", `Escolha os valores de “${src.label}” que mostram este campo.`));
    condition = { fieldId: src.id, values };
  }

  return ok({ label, type: input.type, required: !!input.required, help, options, settings, processTypes: processTypes.value, condition });
}

// ================================================================ sugestões

type FieldSuggestion = Omit<FieldInput, "help" | "settings" | "processTypes" | "condition"> & { help?: string | null; settings?: FieldSettings; processTypes?: ProcessType[]; showWhen?: { label: string; values: string[] } };

export const SUGGESTED_SECTIONS: { key: string; section: SectionInput; fields: FieldSuggestion[] }[] = [
  {
    key: "percurso",
    section: { title: "Percurso escolar anterior", description: "Onde o aluno estudou antes de vir para o colégio.", repeatable: false, entryLabel: "Registo", maxEntries: 1, processTypes: ["NOVA", "TRANSFERENCIA", "REINGRESSO"] },
    fields: [
      { label: "Já frequentou outra escola?", type: "BOOLEAN", required: true, options: [] },
      { label: "Escola anterior", type: "TEXT", required: true, options: [], showWhen: { label: "Já frequentou outra escola?", values: ["Sim"] } },
      { label: "Classe frequentada", type: "SELECT", required: true, options: ["Iniciação", "1.ª", "2.ª", "3.ª", "4.ª", "5.ª", "6.ª", "7.ª", "8.ª", "9.ª", "10.ª", "11.ª", "12.ª", "13.ª"], showWhen: { label: "Já frequentou outra escola?", values: ["Sim"] } },
      { label: "Ano letivo", type: "TEXT", required: false, options: [], help: "Ex.: 2025/2026", showWhen: { label: "Já frequentou outra escola?", values: ["Sim"] } },
      { label: "Média final", type: "NUMBER", required: false, options: [], settings: { min: 0, max: 20 }, showWhen: { label: "Já frequentou outra escola?", values: ["Sim"] } },
      { label: "Província da escola", type: "TEXT", required: false, options: [], showWhen: { label: "Já frequentou outra escola?", values: ["Sim"] } },
      { label: "Motivo da transferência", type: "LONG_TEXT", required: true, options: [], processTypes: ["TRANSFERENCIA"] },
    ],
  },
  {
    key: "adicionais",
    section: { title: "Informações adicionais", description: null, repeatable: false, entryLabel: "Registo", maxEntries: 1, processTypes: [] },
    fields: [
      { label: "Língua estrangeira", type: "SELECT", required: false, options: ["Inglês", "Francês"] },
      { label: "Precisa de acompanhamento pedagógico especial?", type: "BOOLEAN", required: true, options: [] },
      { label: "Qual o acompanhamento?", type: "LONG_TEXT", required: true, options: [], showWhen: { label: "Precisa de acompanhamento pedagógico especial?", values: ["Sim"] } },
      { label: "Turno preferido", type: "SELECT", required: false, options: ["Manhã", "Tarde", "Noite"] },
      { label: "Alergias ou cuidados de saúde", type: "LONG_TEXT", required: false, options: [] },
    ],
  },
];

// ================================================================ versões

export interface SnapshotFixedField extends FixedField {
  mode: FixedMode;
}

export interface SnapshotField extends FieldInput {
  id: string;
}

export interface SnapshotSection extends SectionInput {
  id: string;
  fields: SnapshotField[];
}

export type SnapshotDocument = DocumentTypeInput & { id: string };

export interface FormSnapshot {
  schema: number;
  student: SnapshotFixedField[];
  guardian: SnapshotFixedField[];
  sections: SnapshotSection[];
  documents: SnapshotDocument[];
}

/** O formulário de um processo: só as secções, campos e documentos que lhe pertencem. */
export function forProcess(s: FormSnapshot, p: ProcessType): FormSnapshot {
  return {
    ...s,
    sections: s.sections.filter((x) => inProcess(x, p)).map((x) => ({ ...x, fields: x.fields.filter((f) => inProcess(f, p)) })).filter((x) => x.fields.length > 0),
    documents: s.documents.filter((d) => inProcess(d, p)),
  };
}

/** Ordem estável das chaves (o JSONB reordena-as): compara a configuração com a versão publicada. */
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
  if (!from) return ["Primeira versão dos formulários."];
  const out: string[] = [];
  for (const [scope, title] of [
    ["student", "Dados do aluno"],
    ["guardian", "Dados do encarregado"],
  ] as const) {
    const before = new Map(from[scope].map((f) => [f.key, f.mode]));
    for (const f of to[scope]) if (before.get(f.key) !== f.mode) out.push(`${title}: “${f.label}” passa a ${FIXED_MODE_LABELS[f.mode].toLowerCase()}.`);
  }
  const prevSections = new Map(from.sections.map((s) => [s.id, s]));
  for (const s of to.sections) {
    const prev = prevSections.get(s.id);
    if (!prev) {
      out.push(`Nova secção “${s.title}” (${s.fields.length} campo${s.fields.length === 1 ? "" : "s"}).`);
      continue;
    }
    const { fields: _a, ...headNow } = s;
    const { fields: _b, ...headPrev } = prev;
    if (canonical(headNow) !== canonical(headPrev)) out.push(`${s.title}: definições da secção alteradas.`);
    const before = new Map(prev.fields.map((f) => [f.id, f]));
    const after = new Set(s.fields.map((f) => f.id));
    const lines: string[] = [];
    for (const f of s.fields) {
      const old = before.get(f.id);
      if (!old) lines.push(`${s.title}: novo campo “${f.label}”.`);
      else if (canonical(old) !== canonical(f)) lines.push(`${s.title}: campo “${f.label}” alterado.`);
    }
    for (const f of prev.fields) if (!after.has(f.id)) lines.push(`${s.title}: campo “${f.label}” retirado.`);
    const kept = prev.fields.filter((f) => after.has(f.id)).map((f) => f.id);
    const now = s.fields.filter((f) => before.has(f.id)).map((f) => f.id);
    if (!lines.length && kept.join() !== now.join()) lines.push(`${s.title}: nova ordem dos campos.`);
    out.push(...lines);
  }
  const nowSections = new Set(to.sections.map((s) => s.id));
  for (const s of from.sections) if (!nowSections.has(s.id)) out.push(`Secção “${s.title}” retirada.`);
  const beforeDocs = new Map(from.documents.map((d) => [d.id, d]));
  const afterDocs = new Set(to.documents.map((d) => d.id));
  for (const d of to.documents) {
    const old = beforeDocs.get(d.id);
    if (!old) out.push(`Documentos: novo “${d.name}”.`);
    else if (canonical(old) !== canonical(d)) out.push(`Documentos: “${d.name}” alterado.`);
  }
  for (const d of from.documents) if (!afterDocs.has(d.id)) out.push(`Documentos: “${d.name}” retirado.`);
  if (!out.length && canonical(from) !== canonical(to)) out.push("Nova ordem de secções ou documentos.");
  return out;
}
