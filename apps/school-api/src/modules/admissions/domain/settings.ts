/**
 * INSCRIÇÕES E MATRÍCULAS — configuração (1.ª parte).
 *   períodos     por ano letivo: inscrições, matrículas e renovações (cada um: de … a …, ou fechado)
 *                o estado de cada período calcula-se pela data de hoje em Luanda
 *   processos    nova inscrição · renovação · transferência · reingresso
 *   documentos   a quem se pedem (aluno, encarregado ou ambos), em que processos (vazio = todos),
 *                formatos, tamanho, n.º de ficheiros, validade
 */
import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

export type AdmissionErrorCode =
  | "INVALID_INPUT"
  | "YEAR_NOT_FOUND"
  | "YEAR_CLOSED"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_EXISTS"
  | "LIMIT_REACHED"
  | "FORBIDDEN"
  // formulários
  | "SECTION_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "FIELD_IN_USE"
  | "NOTHING_TO_PUBLISH"
  | "VERSION_NOT_FOUND"
  // inscrições (área da família)
  | "APPLICATION_NOT_FOUND"
  | "APPLICATIONS_CLOSED"
  | "NOT_EDITABLE"
  | "STALE"
  | "INCOMPLETE"
  | "DUPLICATE_APPLICATION"
  | "FILE_NOT_FOUND"
  | "INVALID_FILE"
  | "STORAGE_UNAVAILABLE"
  // matrículas
  | "ALREADY_ENROLLED"
  | "NO_VACANCY"
  | "NO_GROUPS"
  | "ENROLLMENT_NOT_FOUND"
  // alunos
  | "STUDENT_NOT_FOUND"
  | "TEACHER_NOT_FOUND";
export type AdmissionError = DomainError<AdmissionErrorCode>;
export const admissionError = (code: AdmissionErrorCode, message: string, meta?: Record<string, unknown>): AdmissionError => new DomainError(code, message, meta);

export const PROCESS_TYPES = {
  NOVA: { label: "Primeira inscrição", hint: "Aluno novo no colégio." },
  RENOVACAO: { label: "Renovação de matrícula", hint: "Aluno do colégio que continua no ano seguinte." },
  TRANSFERENCIA: { label: "Transferência", hint: "Aluno que vem de outra escola a meio do percurso." },
  REINGRESSO: { label: "Reingresso", hint: "Antigo aluno que volta ao colégio." },
} as const;
export type ProcessType = keyof typeof PROCESS_TYPES;
export const PROCESS_TYPE_KEYS = Object.keys(PROCESS_TYPES) as ProcessType[];

export const DOCUMENT_TARGETS = {
  STUDENT: { label: "Do aluno", hint: "ex.: cédula, certificado de habilitações" },
  GUARDIAN: { label: "Do encarregado", hint: "ex.: BI do encarregado (só quando o aluno é menor)" },
  BOTH: { label: "Do aluno e do encarregado", hint: "Pedido a cada um (ex.: BI)" },
} as const;
export type DocumentTarget = keyof typeof DOCUMENT_TARGETS;

export const FILE_FORMATS = ["pdf", "jpg", "png", "webp", "doc", "docx"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];
export const MAX_DOCUMENT_TYPES = 30;

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || null;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// ================================================================ períodos

export const PERIOD_KINDS = {
  applications: "Inscrições",
  enrollments: "Matrículas",
  renewals: "Renovações",
} as const;
export type PeriodKind = keyof typeof PERIOD_KINDS;
export const PERIOD_KIND_KEYS = Object.keys(PERIOD_KINDS) as PeriodKind[];

export type Window = { from: string; to: string } | null;
export type Periods = Record<PeriodKind, Window>;

/**
 * Valida os três períodos de um ano letivo. Podem começar até um ano antes do início do
 * ano letivo (inscrições e renovações abrem antes das aulas) e acabam até ao fim dele.
 */
export function checkPeriods(input: Record<PeriodKind, { from: string; to: string } | null | undefined>, year: { startsOn: string; endsOn: string }): Result<Periods, AdmissionError> {
  const out = {} as Periods;
  const earliest = `${Number(year.startsOn.slice(0, 4)) - 1}${year.startsOn.slice(4)}`;
  for (const k of PERIOD_KIND_KEYS) {
    const w = input[k];
    if (!w) {
      out[k] = null;
      continue;
    }
    const label = PERIOD_KINDS[k];
    if (!validDay(w.from) || !validDay(w.to)) return fail(admissionError("INVALID_INPUT", `${label}: datas inválidas.`));
    if (w.from > w.to) return fail(admissionError("INVALID_INPUT", `${label}: o fim tem de ser depois do início.`));
    if (w.from < earliest) return fail(admissionError("INVALID_INPUT", `${label}: não pode abrir mais de um ano antes do início do ano letivo.`));
    if (w.to > year.endsOn) return fail(admissionError("INVALID_INPUT", `${label}: tem de fechar até ao fim do ano letivo (${year.endsOn.split("-").reverse().join("/")}).`));
    out[k] = { from: w.from, to: w.to };
  }
  return ok(out);
}

export type PeriodState = "OPEN" | "UPCOMING" | "CLOSED" | "NOT_SET";
export const PERIOD_STATE_LABELS: Record<PeriodState, string> = { OPEN: "Aberto", UPCOMING: "Por abrir", CLOSED: "Fechado", NOT_SET: "Por definir" };
export const periodState = (w: Window, today: string): PeriodState => (!w ? "NOT_SET" : today < w.from ? "UPCOMING" : today > w.to ? "CLOSED" : "OPEN");

// ================================================================ documentos

export interface DocumentTypeInput {
  name: string;
  description: string | null;
  required: boolean;
  target: DocumentTarget;
  processTypes: ProcessType[];
  formats: FileFormat[];
  maxSizeMb: number;
  maxFiles: number;
  needsExpiry: boolean;
}

export function checkDocumentType(input: {
  name: string;
  description?: string | null;
  required: boolean;
  target: string;
  processTypes?: string[];
  formats: string[];
  maxSizeMb: number;
  maxFiles: number;
  needsExpiry?: boolean;
}): Result<DocumentTypeInput, AdmissionError> {
  const name = clean(input.name);
  if (!name || name.length < 2 || name.length > 80) return fail(admissionError("INVALID_INPUT", "O nome do documento tem entre 2 e 80 caracteres."));
  const description = clean(input.description);
  if (description && description.length > 240) return fail(admissionError("INVALID_INPUT", "A descrição tem no máximo 240 caracteres."));
  if (!(input.target in DOCUMENT_TARGETS)) return fail(admissionError("INVALID_INPUT", "Escolha a quem se pede o documento."));
  const processTypes = [...new Set(input.processTypes ?? [])];
  if (processTypes.some((p) => !(p in PROCESS_TYPES))) return fail(admissionError("INVALID_INPUT", "Processo inválido."));
  const formats = FILE_FORMATS.filter((f) => input.formats.includes(f));
  if (!formats.length || formats.length !== new Set(input.formats).size) return fail(admissionError("INVALID_INPUT", "Escolha os formatos aceites (PDF, JPG, PNG, WEBP, DOC, DOCX)."));
  if (!Number.isInteger(input.maxSizeMb) || input.maxSizeMb < 1 || input.maxSizeMb > 20) return fail(admissionError("INVALID_INPUT", "O tamanho máximo vai de 1 a 20 MB."));
  if (!Number.isInteger(input.maxFiles) || input.maxFiles < 1 || input.maxFiles > 10) return fail(admissionError("INVALID_INPUT", "O número de ficheiros vai de 1 a 10."));
  return ok({
    name,
    description,
    required: input.required,
    target: input.target as DocumentTarget,
    // todos os processos escolhidos = "todos" (vazio)
    processTypes: processTypes.length === PROCESS_TYPE_KEYS.length ? [] : PROCESS_TYPE_KEYS.filter((p) => processTypes.includes(p)),
    formats,
    maxSizeMb: input.maxSizeMb,
    maxFiles: input.maxFiles,
    needsExpiry: !!input.needsExpiry,
  });
}

/** Documentos sugeridos (o colégio escolhe os que quer e depois ajusta). */
export const SUGGESTED_DOCUMENTS: DocumentTypeInput[] = [
  { name: "Bilhete de Identidade", description: "Frente e verso.", required: true, target: "BOTH", processTypes: [], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 2, needsExpiry: true },
  { name: "Cédula ou certidão de nascimento", description: "Para quem ainda não tem BI.", required: false, target: "STUDENT", processTypes: ["NOVA", "TRANSFERENCIA", "REINGRESSO"], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 2, needsExpiry: false },
  { name: "Certificado de habilitações", description: "Da última classe concluída.", required: true, target: "STUDENT", processTypes: ["NOVA", "TRANSFERENCIA", "REINGRESSO"], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 3, needsExpiry: false },
  { name: "Declaração de notas", description: null, required: false, target: "STUDENT", processTypes: ["NOVA", "TRANSFERENCIA"], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 3, needsExpiry: false },
  { name: "Declaração de transferência", description: "Emitida pela escola anterior.", required: true, target: "STUDENT", processTypes: ["TRANSFERENCIA"], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 2, needsExpiry: false },
  { name: "Atestado médico", description: "Emitido há menos de 6 meses.", required: false, target: "STUDENT", processTypes: [], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 1, needsExpiry: true },
  { name: "Cartão de vacinas", description: null, required: false, target: "STUDENT", processTypes: ["NOVA"], formats: ["pdf", "jpg", "png"], maxSizeMb: 5, maxFiles: 2, needsExpiry: false },
];
