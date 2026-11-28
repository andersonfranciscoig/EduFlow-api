/**
 * MENSAGENS E GRUPOS — regras puras (sem BD): o texto, os grupos (manuais ou ligados) e a chave
 * única de uma conversa individual (uma só por par de pessoas).
 */
import type { GroupAudience, GroupType, Party } from "../infrastructure/prisma-conversations";

export const MESSAGE_MAX = 4000;
export const MESSAGE_FILES_MAX = 5;
export const GROUP_TYPES: GroupType[] = ["MANUAL", "CLASS", "GRADE", "DEPARTMENT", "INSTITUTION"];
export const GROUP_TYPE_LABELS: Record<GroupType, string> = { MANUAL: "Grupo", CLASS: "Turma", GRADE: "Classe", DEPARTMENT: "Departamento", INSTITUTION: "Toda a equipa" };
export const GROUP_AUDIENCE_LABELS: Record<GroupAudience, string> = { GUARDIANS: "encarregados", TEACHERS: "professores", STUDENTS: "alunos", STAFF: "equipa", ALL: "professores, alunos e encarregados" };

/** A conversa individual de duas pessoas é sempre a mesma (a ordem não conta). */
export const directKey = (a: Party, b: Party) => [`${a.kind}:${a.id}`, `${b.kind}:${b.id}`].sort().join("|");

export function checkMessage(body: unknown, files: number): { ok: true; value: string } | { ok: false; message: string } {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!text && !files) return { ok: false, message: "Escreva a mensagem ou junte um ficheiro." };
  if (text.length > MESSAGE_MAX) return { ok: false, message: `A mensagem tem no máximo ${MESSAGE_MAX} caracteres.` };
  if (files > MESSAGE_FILES_MAX) return { ok: false, message: `No máximo ${MESSAGE_FILES_MAX} ficheiros por mensagem.` };
  return { ok: true, value: text };
}

export interface GroupInput {
  title: string;
  description: string | null;
  groupType: GroupType;
  refId: string | null;
  refText: string | null;
  audience: GroupAudience | null;
  onlyAdminsPost: boolean;
  membersCanAdd: boolean;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function checkGroup(input: { title?: unknown; description?: unknown; groupType?: unknown; refId?: unknown; refText?: unknown; audience?: unknown; onlyAdminsPost?: unknown; membersCanAdd?: unknown }):
  | { ok: true; value: GroupInput }
  | { ok: false; message: string } {
  const title = clean(input.title, 80);
  if (title.length < 2) return { ok: false, message: "Escreva o nome do grupo (2 a 80 caracteres)." };
  const description = clean(input.description, 400) || null;
  const groupType = (input.groupType ?? "MANUAL") as GroupType;
  if (!GROUP_TYPES.includes(groupType)) return { ok: false, message: "Tipo de grupo inválido." };
  let refId: string | null = null;
  let refText: string | null = null;
  let audience: GroupAudience | null = null;
  if (groupType === "CLASS" || groupType === "GRADE") {
    if (typeof input.refId !== "string" || !UUID.test(input.refId)) return { ok: false, message: groupType === "CLASS" ? "Escolha a turma." : "Escolha a classe." };
    refId = input.refId.toLowerCase();
    const a = (input.audience ?? "ALL") as GroupAudience;
    if (!["GUARDIANS", "TEACHERS", "STUDENTS", "ALL"].includes(a)) return { ok: false, message: "Escolha quem entra no grupo." };
    audience = a;
  }
  if (groupType === "DEPARTMENT") {
    refText = clean(input.refText, 120);
    if (!refText) return { ok: false, message: "Escolha o departamento." };
    audience = "STAFF";
  }
  if (groupType === "INSTITUTION") audience = "STAFF";
  return { ok: true, value: { title, description, groupType, refId, refText, audience, onlyAdminsPost: input.onlyAdminsPost === true, membersCanAdd: input.membersCanAdd === true } };
}
