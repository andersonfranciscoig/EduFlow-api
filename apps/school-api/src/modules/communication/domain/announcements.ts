import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";

/**
 * AVISOS — regras puras (sem BD): o aviso, os destinatários escolhidos e o que cada autoridade pode
 * escolher (toda a comunidade, só a equipa, ou o diretor de turma para as suas turmas).
 */
export type CommunicationErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "CHANGED" | "NOT_AVAILABLE" | "NAME_TAKEN";
export type CommunicationError = DomainError<CommunicationErrorCode>;
export const communicationError = (code: CommunicationErrorCode, message: string, meta?: Record<string, unknown>): CommunicationError => new DomainError(code, message, meta);

export const PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { NORMAL: "Normal", HIGH: "Alta", URGENT: "Urgente" };
export const STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<Status, string> = { DRAFT: "Rascunho", SCHEDULED: "Agendado", PUBLISHED: "Publicado", ARCHIVED: "Arquivado" };
/** a autoridade com que se publica */
export type Scope = "ALL" | "STAFF" | "CLASS";

export const TARGET_KINDS = ["ALL", "STUDENTS", "GUARDIANS", "TEACHERS", "STAFF", "CLASS", "GROUP", "DEPARTMENT", "USER", "FAMILY"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export type GroupAudience = "STUDENTS" | "GUARDIANS" | "BOTH";
export interface Target {
  kind: TargetKind;
  refId?: string | null;
  refText?: string | null;
  audience?: GroupAudience | null;
}
export const TARGET_LABELS: Record<TargetKind, string> = {
  ALL: "Toda a instituição",
  STUDENTS: "Alunos (com conta)",
  GUARDIANS: "Encarregados",
  TEACHERS: "Professores",
  STAFF: "Funcionários",
  CLASS: "Classe",
  GROUP: "Turma",
  DEPARTMENT: "Departamento",
  USER: "Pessoa da equipa",
  FAMILY: "Encarregado ou aluno",
};
export const AUDIENCE_LABELS: Record<GroupAudience, string> = { STUDENTS: "alunos", GUARDIANS: "encarregados", BOTH: "alunos e encarregados" };

/** o que cada autoridade pode escolher (validado de novo no backend em cada gravação) */
const ALLOWED: Record<Scope, TargetKind[]> = {
  ALL: [...TARGET_KINDS],
  STAFF: ["TEACHERS", "STAFF", "DEPARTMENT", "USER"],
  CLASS: ["GROUP"],
};
export const allowedKinds = (s: Scope) => ALLOWED[s];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, max);

/** Os destinatários: pelo menos um, sem repetidos, cada um bem formado e permitido à autoridade. */
export function checkTargets(list: Target[] | null | undefined, scope: Scope): { ok: true; value: Target[] } | { ok: false; message: string } {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const kind = raw.kind;
    if (!TARGET_KINDS.includes(kind)) return { ok: false, message: "Destinatário desconhecido." };
    if (!ALLOWED[scope].includes(kind)) return { ok: false, message: scope === "CLASS" ? "Como diretor de turma, só pode escolher as suas turmas." : `Não pode publicar para “${TARGET_LABELS[kind]}”.` };
    const t: Target = { kind, refId: null, refText: null, audience: null };
    if (kind === "CLASS" || kind === "GROUP" || kind === "USER" || kind === "FAMILY") {
      if (!raw.refId || !UUID.test(raw.refId)) return { ok: false, message: `Escolha ${kind === "CLASS" ? "a classe" : kind === "GROUP" ? "a turma" : "a pessoa"}.` };
      t.refId = raw.refId.toLowerCase();
    }
    if (kind === "CLASS" || kind === "GROUP") {
      const a = raw.audience ?? "BOTH";
      if (a !== "STUDENTS" && a !== "GUARDIANS" && a !== "BOTH") return { ok: false, message: "Escolha se é para os alunos, os encarregados ou ambos." };
      t.audience = a;
    }
    if (kind === "DEPARTMENT") {
      const d = clean(raw.refText, 120);
      if (!d) return { ok: false, message: "Escolha o departamento." };
      t.refText = d;
    }
    const key = `${t.kind}|${t.refId ?? ""}|${(t.refText ?? "").toLowerCase()}|${t.audience ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  if (!out.length) return { ok: false, message: "Escolha pelo menos um destinatário." };
  if (out.length > 50) return { ok: false, message: "No máximo 50 grupos de destinatários por aviso." };
  return { ok: true, value: out };
}

export interface AnnouncementInput {
  title: string;
  body: string;
  categoryId: string;
  priority: Priority;
  pinned: boolean;
  requiresAck: boolean;
  /** null = publicar já (ou guardar como rascunho) */
  publishAt: string | null;
  expiresAt: string | null;
  targets: Target[];
}

/** O aviso: título, texto, datas coerentes (a expiração depois da publicação). */
export function checkAnnouncement(input: { title?: unknown; body?: unknown; categoryId?: unknown; priority?: unknown; pinned?: unknown; requiresAck?: unknown; publishAt?: unknown; expiresAt?: unknown }, now: Date):
  | { ok: true; value: Omit<AnnouncementInput, "targets"> }
  | { ok: false; message: string } {
  const title = clean(input.title, 200);
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, 10000);
  if (title.length < 3) return { ok: false, message: "Escreva o título (3 caracteres ou mais)." };
  if (body.length < 3) return { ok: false, message: "Escreva o texto do aviso." };
  if (typeof input.categoryId !== "string" || !UUID.test(input.categoryId)) return { ok: false, message: "Escolha a categoria." };
  const priority = (input.priority ?? "NORMAL") as Priority;
  if (!PRIORITIES.includes(priority)) return { ok: false, message: "Prioridade inválida." };
  const date = (v: unknown) => (typeof v === "string" && v ? new Date(v) : null);
  const publishAt = date(input.publishAt);
  const expiresAt = date(input.expiresAt);
  if (publishAt && Number.isNaN(publishAt.getTime())) return { ok: false, message: "Data de publicação inválida." };
  if (expiresAt && Number.isNaN(expiresAt.getTime())) return { ok: false, message: "Data de expiração inválida." };
  if (publishAt && publishAt.getTime() > now.getTime() + 366 * 86_400_000) return { ok: false, message: "Agende para daqui a um ano, no máximo." };
  const start = publishAt && publishAt > now ? publishAt : now;
  if (expiresAt && expiresAt <= start) return { ok: false, message: "A expiração tem de ser depois da publicação." };
  return {
    ok: true,
    value: { title, body, categoryId: (input.categoryId as string).toLowerCase(), priority, pinned: input.pinned === true, requiresAck: input.requiresAck === true, publishAt: publishAt && publishAt > now ? publishAt.toISOString() : null, expiresAt: expiresAt ? expiresAt.toISOString() : null },
  };
}

/** Uma categoria do colégio. */
export function checkCategory(name: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const n = clean(name, 60);
  if (n.length < 2) return { ok: false, message: "Escreva o nome da categoria (2 a 60 caracteres)." };
  return { ok: true, value: n };
}

export const ATTACH_MAX = 5;
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
