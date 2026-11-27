import type { Audience, ExtraField } from "./documents";

/**
 * EMISSÃO — os modelos (texto com campos {{...}}), o preenchimento com os dados que o colégio já tem
 * e a validação dos ficheiros carregados. Nunca se inventa um dado: se faltar, a emissão para.
 */
export interface Placeholder {
  key: string;
  label: string;
  /** a quem se aplica (ALL = alunos e funcionários) */
  audience: Audience | "ALL";
  example: string;
}
export const PLACEHOLDERS: Placeholder[] = [
  { key: "institution_name", label: "Nome do colégio", audience: "ALL", example: "Colégio Exemplo" },
  { key: "document_number", label: "N.º do documento", audience: "ALL", example: "DOC-2026-000124" },
  { key: "issue_date", label: "Data de emissão (por extenso)", audience: "ALL", example: "26 de novembro de 2026" },
  { key: "requester_name", label: "Quem pediu", audience: "ALL", example: "Maria Exemplo" },
  { key: "student_name", label: "Nome do aluno", audience: "STUDENT", example: "Ana Exemplo da Silva" },
  { key: "student_number", label: "N.º de aluno", audience: "STUDENT", example: "00042" },
  { key: "birth_date", label: "Data de nascimento", audience: "STUDENT", example: "10/03/2012" },
  { key: "class_name", label: "Classe", audience: "STUDENT", example: "8.ª Classe" },
  { key: "group_name", label: "Turma", audience: "STUDENT", example: "8.ª A" },
  { key: "academic_year", label: "Ano letivo", audience: "STUDENT", example: "2026/2027" },
  { key: "shift", label: "Turno", audience: "STUDENT", example: "Manhã" },
  { key: "employee_name", label: "Nome do funcionário", audience: "EMPLOYEE", example: "João Exemplo" },
  { key: "employee_number", label: "N.º do funcionário", audience: "EMPLOYEE", example: "0007" },
  { key: "employee_position", label: "Função", audience: "EMPLOYEE", example: "Professor" },
  { key: "employee_department", label: "Departamento", audience: "EMPLOYEE", example: "Ensino" },
];
const FIELD_PREFIX = "campo.";
const TOKEN = /\{\{\s*([a-z_]+(?:\.[a-z0-9-]+)?)\s*\}\}/g;

/** Os campos usados num texto (sem repetidos, pela ordem). */
export const placeholdersIn = (text: string) => [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];

/** Os campos que um modelo pode usar: os do público e os campos extra do tipo ({{campo.chave}}). */
export const allowedFor = (audience: Audience, fields: ExtraField[]) => [
  ...PLACEHOLDERS.filter((p) => p.audience === "ALL" || p.audience === audience).map((p) => ({ key: p.key, label: p.label, example: p.example })),
  ...fields.map((f) => ({ key: `${FIELD_PREFIX}${f.key}`, label: `Campo do pedido: ${f.label}`, example: f.kind === "CHOICE" ? (f.options[0] ?? "Opção") : f.label })),
];

export interface TemplateInput {
  title: string;
  body: string;
  signerName: string | null;
  signerRole: string | null;
  showLogo: boolean;
}
const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max + 1);

/** O modelo: título, texto (parágrafos separados por linha em branco) e só campos que existem. */
export function checkTemplate(input: TemplateInput, audience: Audience, fields: ExtraField[]): { ok: true; value: TemplateInput } | { ok: false; message: string } {
  const title = clean(input.title, 160);
  if (title.length < 3 || title.length > 160) return { ok: false, message: "O título do documento tem 3 a 160 caracteres." };
  const body = String(input.body ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (body.length < 20 || body.length > 6000) return { ok: false, message: "O texto do documento tem 20 a 6000 caracteres." };
  const allowed = new Set(allowedFor(audience, fields).map((p) => p.key));
  const unknown = [...placeholdersIn(title), ...placeholdersIn(body)].filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, message: `Campos que este documento não tem: ${unknown.map((k) => `{{${k}}}`).join(", ")}.` };
  const signerName = clean(input.signerName, 120) || null;
  const signerRole = clean(input.signerRole, 120) || null;
  if ((signerName?.length ?? 0) > 120 || (signerRole?.length ?? 0) > 120) return { ok: false, message: "O nome e o cargo de quem assina têm no máximo 120 caracteres." };
  return { ok: true, value: { title, body, signerName, signerRole, showLogo: !!input.showLogo } };
}

/** Preenche os campos; devolve o que falta (um dado vazio nunca se inventa). */
export function fill(text: string, values: Record<string, string | null | undefined>) {
  const missing = new Set<string>();
  const out = text.replace(TOKEN, (_, key: string) => {
    const v = values[key]?.toString().trim();
    if (!v) {
      missing.add(key);
      return "";
    }
    return v;
  });
  return { text: out, missing: [...missing] };
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "26 de novembro de 2026" (a partir de AAAA-MM-DD). */
export const longDate = (day: string) => `${Number(day.slice(8, 10))} de ${MONTHS[Number(day.slice(5, 7)) - 1]} de ${day.slice(0, 4)}`;
export const SHIFTS: Record<string, string> = { MANHA: "Manhã", TARDE: "Tarde", NOITE: "Noite" };

/** O nome de um campo para a mensagem do que falta. */
export const placeholderLabel = (key: string, fields: ExtraField[]) =>
  key.startsWith(FIELD_PREFIX) ? (fields.find((f) => `${FIELD_PREFIX}${f.key}` === key)?.label ?? key) : (PLACEHOLDERS.find((p) => p.key === key)?.label ?? key);
export const fieldKey = (k: string) => `${FIELD_PREFIX}${k}`;

// ---------------------------------------------------------------- ficheiros carregados

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS: Record<string, string[]> = { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"] };

/** O tipo REAL do ficheiro (pelos primeiros bytes), não o que o navegador diz. */
export function sniff(b: Buffer): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

/** Um ficheiro carregado: PDF, JPG ou PNG, até 10 MB, com o conteúdo, a extensão e o tipo de acordo. */
export function checkUpload(f: { originalname: string; mimetype: string; buffer: Buffer } | undefined): { ok: true; mime: "application/pdf" | "image/jpeg" | "image/png"; name: string } | { ok: false; message: string } {
  if (!f || !f.buffer?.length) return { ok: false, message: "Escolha o ficheiro do documento (PDF, JPG ou PNG)." };
  if (f.buffer.length > UPLOAD_MAX_BYTES) return { ok: false, message: "O ficheiro tem mais de 10 MB." };
  const real = sniff(f.buffer);
  if (!real) return { ok: false, message: "O ficheiro não é um PDF, JPG ou PNG válido." };
  const ext = (f.originalname.split(".").pop() ?? "").toLowerCase();
  if (!EXTENSIONS[real].includes(ext)) return { ok: false, message: "A extensão do ficheiro não corresponde ao seu conteúdo." };
  if (f.mimetype && f.mimetype !== real && !(real === "image/jpeg" && f.mimetype === "image/jpg")) return { ok: false, message: "O tipo do ficheiro não corresponde ao seu conteúdo." };
  // o nome guardado: só caracteres seguros
  const base = f.originalname.replace(/\.[^.]+$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 80) || "documento";
  return { ok: true, mime: real, name: `${base}.${EXTENSIONS[real][0]}` };
}
