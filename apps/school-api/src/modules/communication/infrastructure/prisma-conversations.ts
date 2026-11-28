import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { PrismaAnnouncementsRepository } from "./prisma-announcements";

type Db = PrismaClient | Prisma.TransactionClient;

export type PartyKind = "STAFF" | "FAMILY";
export interface Party {
  kind: PartyKind;
  id: string;
}
export interface Contact extends Party {
  name: string;
  label: string;
}
export type GroupType = "MANUAL" | "CLASS" | "GRADE" | "DEPARTMENT" | "INSTITUTION";
export type GroupAudience = "GUARDIANS" | "TEACHERS" | "STUDENTS" | "STAFF" | "ALL";
export interface ConversationRow {
  id: string;
  kind: "DIRECT" | "GROUP";
  title: string | null;
  description: string | null;
  groupType: GroupType | null;
  refId: string | null;
  refText: string | null;
  audience: GroupAudience | null;
  onlyAdminsPost: boolean;
  membersCanAdd: boolean;
  createdByKind: PartyKind;
  createdById: string;
  createdAt: Date;
  lastMessageAt: Date | null;
  syncedAt: Date | null;
}
export interface MemberRow extends Party {
  name: string;
  label: string | null;
  role: "ADMIN" | "MEMBER";
  source: "MANUAL" | "SYNC";
  joinedAt: Date;
  leftAt: Date | null;
  lastReadAt: Date | null;
  deliveredAt: Date | null;
  archived: boolean;
}
export interface MessageRow {
  id: string;
  kind: "TEXT" | "SYSTEM";
  senderKind: PartyKind | null;
  senderId: string | null;
  senderName: string | null;
  body: string;
  createdAt: Date;
}
export interface FileRow {
  id: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
}

const LIVE = Prisma.sql`e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM academic_years y WHERE y.id = e.academic_year_id AND y.status <> 'CLOSED')`;
const first = (n: string) => n.split(/\s+/)[0] ?? n;
const C_SQL = Prisma.sql`
  SELECT c.id, c.kind, c.title, c.description, c.group_type AS "groupType", c.ref_id AS "refId", c.ref_text AS "refText", c.audience,
         c.only_admins_post AS "onlyAdminsPost", c.members_can_add AS "membersCanAdd", c.created_by_kind AS "createdByKind", c.created_by_id AS "createdById",
         c.created_at AS "createdAt", c.last_message_at AS "lastMessageAt", c.synced_at AS "syncedAt"
    FROM conversations c`;
const M_SQL = Prisma.sql`
  SELECT member_kind AS kind, member_id AS id, member_name AS name, label, role, source, joined_at AS "joinedAt", left_at AS "leftAt",
         last_read_at AS "lastReadAt", delivered_at AS "deliveredAt", archived
    FROM conversation_members`;
const groupLabel = (grade: number | null, course: string | null, name: string) => `${grade === null ? "" : `${gradeLabel(grade)}${course ? ` ${course}` : ""} · `}${name}`;

/** Conversas, grupos, mensagens e anexos; e quem pode falar com quem (relações académicas do colégio). */
export class PrismaConversationsRepository {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaConversationsRepository(db);
  }
  async transaction<T>(fn: (repo: PrismaConversationsRepository) => Promise<T>): Promise<T> {
    return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaConversationsRepository(tx)), { timeout: 30_000 });
  }
  async activity(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  // ================================================================ quem é quem

  async staffName(id: string) {
    const [r] = await this.db.$queryRaw<{ name: string; active: boolean }[]>`SELECT full_name AS name, status = 'ACTIVE' AS active FROM school_users WHERE id = ${id}::uuid`;
    return r ?? null;
  }
  async familyAccount(id: string) {
    const [r] = await this.db.$queryRaw<{ name: string; kind: "GUARDIAN" | "STUDENT"; active: boolean }[]>`SELECT full_name AS name, kind, status = 'ACTIVE' AS active FROM family_accounts WHERE id = ${id}::uuid`;
    return r ?? null;
  }
  /** As turmas que um utilizador da equipa dirige ou onde dá aulas (anos letivos que não terminaram). */
  async teachingGroups(userId: string) {
    return this.db.$queryRaw<{ id: string; label: string; coordinator: boolean }[]>`
      SELECT g.id, c.grade::text || '|' || coalesce(co.name, '') || '|' || g.name AS label, bool_or(g.coordinator_id = emp.id) AS coordinator
        FROM employees emp JOIN class_groups g ON (g.coordinator_id = emp.id OR EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.group_id = g.id AND gt.employee_id = emp.id))
        JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id JOIN academic_years y ON y.id = g.academic_year_id
       WHERE emp.user_id = ${userId}::uuid AND y.status <> 'CLOSED' GROUP BY g.id, c.grade, co.name, g.name`;
  }

  /** As classes, turmas e departamentos (para os grupos ligados) — os mesmos dos avisos. */
  async groupOptions() {
    return new PrismaAnnouncementsRepository(this.db).options();
  }

  // ================================================================ fotografias de perfil

  /** A fotografia: a escolhida; senão, para o aluno com conta, a da secretaria ou a da inscrição. */
  async photo(p: Party): Promise<{ storageKey: string; mimeType: string; updatedAt: Date | null } | null> {
    const [own] = await this.db.$queryRaw<{ storageKey: string; mimeType: string; updatedAt: Date }[]>`
      SELECT storage_key AS "storageKey", mime_type AS "mimeType", updated_at AS "updatedAt" FROM profile_photos WHERE party_kind = ${p.kind} AND party_id = ${p.id}::uuid`;
    if (own) return own;
    if (p.kind !== "FAMILY") return null;
    const [st] = await this.db.$queryRaw<{ storageKey: string; mimeType: string; updatedAt: Date }[]>`
      SELECT x.storage_key AS "storageKey", x.mime_type AS "mimeType", x.created_at AS "updatedAt" FROM students s
        JOIN LATERAL (
          SELECT * FROM (
            SELECT 'UPLOAD' AS source, sp.storage_key, sp.mime_type, sp.created_at FROM student_photos sp WHERE sp.student_id = s.id
            UNION ALL
            SELECT 'APPLICATION', fi.storage_key, fi.mime_type, fi.created_at FROM application_files fi JOIN applications a ON a.id = fi.application_id
             WHERE a.student_id = s.id AND fi.slot = 'PHOTO' AND a.status <> 'DRAFT'
          ) y ORDER BY (y.source = 'UPLOAD') DESC, y.created_at DESC LIMIT 1
        ) x ON true
       WHERE s.account_id = ${p.id}::uuid LIMIT 1`;
    return st ?? null;
  }
  async setPhoto(p: Party, f: { storageKey: string; mimeType: string } | null, now: Date) {
    if (!f) return this.db.$executeRaw`DELETE FROM profile_photos WHERE party_kind = ${p.kind} AND party_id = ${p.id}::uuid`;
    return this.db.$executeRaw`
      INSERT INTO profile_photos (party_kind, party_id, storage_key, mime_type, updated_at) VALUES (${p.kind}, ${p.id}::uuid, ${f.storageKey}, ${f.mimeType}, ${now})
      ON CONFLICT (party_kind, party_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, mime_type = EXCLUDED.mime_type, updated_at = EXCLUDED.updated_at`;
  }
  async hasOwnPhoto(p: Party) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM profile_photos WHERE party_kind = ${p.kind} AND party_id = ${p.id}::uuid`;
    return (r?.n ?? 0) > 0;
  }
  /** Duas pessoas partilham uma conversa (para ver a fotografia uma da outra). */
  async shareConversation(a: Party, b: Party) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversation_members x JOIN conversation_members y ON y.conversation_id = x.conversation_id
       WHERE x.member_kind = ${a.kind} AND x.member_id = ${a.id}::uuid AND y.member_kind = ${b.kind} AND y.member_id = ${b.id}::uuid`;
    return (r?.n ?? 0) > 0;
  }

  // ================================================================ contactos (quem posso iniciar)

  /** Família: os professores e os diretores de turma dos alunos da conta (o próprio, se maior; os educandos). */
  async familyContacts(accountId: string, onlyId: string | null = null): Promise<Contact[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string; student: string; subject: string | null; coordinator: boolean; grade: number; course: string | null; groupName: string }[]>`
      WITH mine AS (
        SELECT s.id, s.full_name FROM students s WHERE s.account_id = ${accountId}::uuid
        UNION SELECT s.id, s.full_name FROM students s JOIN student_guardians sg ON sg.student_id = s.id JOIN guardians gd ON gd.id = sg.guardian_id WHERE gd.account_id = ${accountId}::uuid
      ), groups AS (
        SELECT DISTINCT m.full_name AS student, e.group_id FROM mine m JOIN enrollments e ON e.student_id = m.id WHERE ${LIVE} AND e.group_id IS NOT NULL
      )
      SELECT u.id, u.full_name AS name, gr.student, sub.name AS subject, false AS coordinator, c.grade, co.name AS course, g.name AS "groupName"
        FROM groups gr JOIN group_teachers gt ON gt.group_id = gr.group_id JOIN subjects sub ON sub.id = gt.subject_id JOIN employees emp ON emp.id = gt.employee_id
        JOIN school_users u ON u.id = emp.user_id AND u.status = 'ACTIVE' JOIN class_groups g ON g.id = gr.group_id JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE ${onlyId}::uuid IS NULL OR u.id = ${onlyId}::uuid
      UNION ALL
      SELECT u.id, u.full_name, gr.student, NULL, true, c.grade, co.name, g.name
        FROM groups gr JOIN class_groups g ON g.id = gr.group_id JOIN employees emp ON emp.id = g.coordinator_id JOIN school_users u ON u.id = emp.user_id AND u.status = 'ACTIVE'
        JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE ${onlyId}::uuid IS NULL OR u.id = ${onlyId}::uuid`;
    // por professor e por aluno/turma: "Diretor(a) de turma e Professor(a) de Matemática, Português · Pedro (7.ª B)"
    const out = new Map<string, Contact & { by: Map<string, { coordinator: boolean; subjects: string[] }> }>();
    for (const r of rows) {
      const cur = out.get(r.id) ?? { kind: "STAFF" as const, id: r.id, name: r.name, label: "", by: new Map() };
      const where = `${first(r.student)} (${r.groupName}${r.course ? ` ${r.course}` : ""})`;
      const w = cur.by.get(where) ?? { coordinator: false, subjects: [] };
      if (r.coordinator) w.coordinator = true;
      else if (r.subject && !w.subjects.includes(r.subject)) w.subjects.push(r.subject);
      cur.by.set(where, w);
      out.set(r.id, cur);
    }
    const label = (w: { coordinator: boolean; subjects: string[] }) => [w.coordinator ? "Diretor(a) de turma" : null, w.subjects.length ? `Professor(a) de ${w.subjects.join(", ")}` : null].filter(Boolean).join(" e ");
    return [...out.values()]
      .map(({ by, ...c }) => ({ ...c, label: [...by.entries()].map(([where, w]) => `${label(w)} · ${where}`).join(" · ") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Equipa: as famílias (encarregados e alunos com conta) das turmas onde dá aulas ou que dirige. */
  async teacherFamilies(userId: string, q: string | null, onlyId: string | null = null): Promise<Contact[]> {
    const like = q ? `%${q}%` : null;
    const rows = await this.db.$queryRaw<{ id: string; name: string; kind: string; student: string; grade: number; course: string | null; groupName: string }[]>`
      WITH g AS (
        SELECT DISTINCT cg.id FROM employees emp JOIN class_groups cg ON (cg.coordinator_id = emp.id OR EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.group_id = cg.id AND gt.employee_id = emp.id))
         WHERE emp.user_id = ${userId}::uuid
      ), st AS (
        SELECT e.student_id, e.group_id FROM enrollments e JOIN g ON g.id = e.group_id WHERE ${LIVE}
      ), fam AS (
        SELECT fa.id, fa.full_name AS name, fa.kind, s.full_name AS student, st.group_id FROM st JOIN students s ON s.id = st.student_id JOIN family_accounts fa ON fa.id = s.account_id AND fa.status = 'ACTIVE'
        UNION SELECT fa.id, fa.full_name, fa.kind, s.full_name, st.group_id FROM st JOIN students s ON s.id = st.student_id JOIN student_guardians sg ON sg.student_id = s.id JOIN guardians gd ON gd.id = sg.guardian_id
          JOIN family_accounts fa ON fa.id = gd.account_id AND fa.status = 'ACTIVE'
      )
      SELECT f.id, f.name, f.kind, f.student, c.grade, co.name AS course, cg.name AS "groupName" FROM fam f JOIN class_groups cg ON cg.id = f.group_id JOIN school_classes c ON c.id = cg.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE (${onlyId}::uuid IS NULL OR f.id = ${onlyId}::uuid) AND (${like}::text IS NULL OR f.name ILIKE ${like} OR f.student ILIKE ${like})
       ORDER BY f.name LIMIT 60`;
    const out = new Map<string, Contact & { parts: string[] }>();
    for (const r of rows) {
      const where = `${r.groupName}${r.course ? ` ${r.course}` : ""}`;
      const part = r.kind === "STUDENT" ? `Aluno (${where})` : `Encarregado de ${first(r.student)} (${where})`;
      const cur = out.get(r.id) ?? { kind: "FAMILY" as const, id: r.id, name: r.name, label: "", parts: [] };
      if (!cur.parts.includes(part)) cur.parts.push(part);
      out.set(r.id, cur);
    }
    return [...out.values()].map(({ parts, ...c }) => ({ ...c, label: parts.join(" · ") }));
  }
  /** A equipa (contas ativas do portal), menos o próprio. */
  async staffContacts(userId: string, q: string | null, onlyId: string | null = null): Promise<Contact[]> {
    const like = q ? `%${q}%` : null;
    const rows = await this.db.$queryRaw<{ id: string; name: string; role: string; job: string | null }[]>`
      SELECT u.id, u.full_name AS name, u.role::text AS role, (SELECT emp.job_title FROM employees emp WHERE emp.user_id = u.id LIMIT 1) AS job
        FROM school_users u WHERE u.status = 'ACTIVE' AND u.id <> ${userId}::uuid AND (${onlyId}::uuid IS NULL OR u.id = ${onlyId}::uuid)
         AND (${like}::text IS NULL OR u.full_name ILIKE ${like} OR u.email ILIKE ${like}) ORDER BY u.full_name LIMIT 60`;
    const ROLE: Record<string, string> = { DIRETOR: "Direção", SECRETARIA: "Secretaria", RH: "Recursos Humanos", PROFESSOR: "Professor(a)" };
    return rows.map((r) => ({ kind: "STAFF", id: r.id, name: r.name, label: r.job || ROLE[r.role] || "Equipa" }));
  }
  /** Todas as famílias com conta (com a permissão de escrever às famílias). */
  async allFamilies(q: string | null, onlyId: string | null = null): Promise<Contact[]> {
    const like = q ? `%${q}%` : null;
    const rows = await this.db.$queryRaw<{ id: string; name: string; kind: string }[]>`
      SELECT fa.id, fa.full_name AS name, fa.kind FROM family_accounts fa WHERE fa.status = 'ACTIVE' AND (${onlyId}::uuid IS NULL OR fa.id = ${onlyId}::uuid)
         AND (${like}::text IS NULL OR fa.full_name ILIKE ${like} OR fa.email ILIKE ${like}) ORDER BY fa.full_name LIMIT 60`;
    return rows.map((r) => ({ kind: "FAMILY", id: r.id, name: r.name, label: r.kind === "STUDENT" ? "Aluno" : "Encarregado" }));
  }

  // ================================================================ membros dos grupos ligados (sincronização)

  /** Quem deve estar num grupo ligado (turma, classe, departamento, instituição). */
  async expected(type: GroupType, refId: string | null, refText: string | null, audience: GroupAudience | null): Promise<Contact[]> {
    const out: Contact[] = [];
    const a = audience ?? "ALL";
    const where = type === "CLASS" ? Prisma.sql`e.group_id = ${refId}::uuid` : Prisma.sql`e.class_id = ${refId}::uuid`;
    const groupsOf = type === "CLASS" ? Prisma.sql`SELECT ${refId}::uuid AS id` : Prisma.sql`SELECT id FROM class_groups WHERE class_id = ${refId}::uuid`;
    if (type === "CLASS" || type === "GRADE") {
      if (a === "GUARDIANS" || a === "ALL") {
        const rows = await this.db.$queryRaw<{ id: string; name: string; students: string }[]>`
          SELECT fa.id, fa.full_name AS name, string_agg(DISTINCT split_part(s.full_name, ' ', 1), ', ') AS students
            FROM enrollments e JOIN students s ON s.id = e.student_id JOIN student_guardians sg ON sg.student_id = s.id JOIN guardians gd ON gd.id = sg.guardian_id
            JOIN family_accounts fa ON fa.id = gd.account_id AND fa.status = 'ACTIVE' WHERE ${LIVE} AND ${where} GROUP BY fa.id, fa.full_name`;
        out.push(...rows.map((r) => ({ kind: "FAMILY" as const, id: r.id, name: r.name, label: `Encarregado de ${r.students}` })));
      }
      if (a === "STUDENTS" || a === "ALL") {
        const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
          SELECT DISTINCT fa.id, fa.full_name AS name FROM enrollments e JOIN students s ON s.id = e.student_id JOIN family_accounts fa ON fa.id = s.account_id AND fa.status = 'ACTIVE' AND fa.kind = 'STUDENT'
           WHERE ${LIVE} AND ${where}`;
        out.push(...rows.map((r) => ({ kind: "FAMILY" as const, id: r.id, name: r.name, label: "Aluno" })));
      }
      if (a === "TEACHERS" || a === "ALL") {
        const rows = await this.db.$queryRaw<{ id: string; name: string; subjects: string | null; coordinator: boolean }[]>`
          SELECT u.id, u.full_name AS name, string_agg(DISTINCT sub.name, ', ') AS subjects, bool_or(cg.coordinator_id = emp.id) AS coordinator
            FROM (${groupsOf}) gs JOIN class_groups cg ON cg.id = gs.id JOIN employees emp ON (emp.id = cg.coordinator_id OR EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.group_id = cg.id AND gt.employee_id = emp.id))
            JOIN school_users u ON u.id = emp.user_id AND u.status = 'ACTIVE'
            LEFT JOIN group_teachers gt2 ON gt2.group_id = cg.id AND gt2.employee_id = emp.id LEFT JOIN subjects sub ON sub.id = gt2.subject_id
           GROUP BY u.id, u.full_name`;
        out.push(...rows.map((r) => ({ kind: "STAFF" as const, id: r.id, name: r.name, label: [r.coordinator ? "Diretor(a) de turma" : null, r.subjects ? `Professor(a) de ${r.subjects}` : null].filter(Boolean).join(" · ") || "Professor(a)" })));
      }
    } else if (type === "DEPARTMENT") {
      const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
        SELECT u.id, u.full_name AS name FROM school_users u WHERE u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM employees emp WHERE emp.user_id = u.id AND emp.status <> 'TERMINATED'
          AND (lower(btrim(emp.department)) = lower(${refText}) OR EXISTS (SELECT 1 FROM employee_contracts ec WHERE ec.employee_id = emp.id AND lower(btrim(ec.department)) = lower(${refText}))))`;
      out.push(...rows.map((r) => ({ kind: "STAFF" as const, id: r.id, name: r.name, label: refText ?? "Departamento" })));
    } else if (type === "INSTITUTION") {
      out.push(...(await this.staffContacts("00000000-0000-0000-0000-000000000000", null)).map((c) => ({ ...c })));
    }
    const seen = new Map<string, Contact>();
    for (const c of out) if (!seen.has(`${c.kind}|${c.id}`)) seen.set(`${c.kind}|${c.id}`, c);
    return [...seen.values()];
  }
  async targetLabel(type: GroupType, refId: string | null) {
    if (type === "CLASS") {
      const [r] = await this.db.$queryRaw<{ grade: number; course: string | null; name: string }[]>`SELECT c.grade, co.name AS course, g.name FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id WHERE g.id = ${refId}::uuid`;
      return r ? groupLabel(r.grade, r.course, r.name) : null;
    }
    if (type === "GRADE") {
      const [r] = await this.db.$queryRaw<{ grade: number; course: string | null }[]>`SELECT c.grade, co.name AS course FROM school_classes c LEFT JOIN courses co ON co.id = c.course_id WHERE c.id = ${refId}::uuid`;
      return r ? `${gradeLabel(r.grade)}${r.course ? ` ${r.course}` : ""}` : null;
    }
    return null;
  }

  // ================================================================ conversas

  async conversation(id: string): Promise<ConversationRow | null> {
    const [r] = await this.db.$queryRaw<ConversationRow[]>`${C_SQL} WHERE c.id = ${id}::uuid`;
    return r ?? null;
  }
  async directByKey(key: string) {
    const [r] = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM conversations WHERE direct_key = ${key}`;
    return r?.id ?? null;
  }
  async createConversation(c: { kind: "DIRECT" | "GROUP"; title?: string | null; description?: string | null; groupType?: GroupType | null; refId?: string | null; refText?: string | null; audience?: GroupAudience | null; onlyAdminsPost?: boolean; membersCanAdd?: boolean; directKey?: string | null; by: Party }, now: Date) {
    const id = randomUUID();
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      INSERT INTO conversations (id, kind, title, description, group_type, ref_id, ref_text, audience, only_admins_post, members_can_add, direct_key, created_by_kind, created_by_id, created_at, updated_at, synced_at)
      VALUES (${id}::uuid, ${c.kind}, ${c.title ?? null}, ${c.description ?? null}, ${c.groupType ?? null}, ${c.refId ?? null}::uuid, ${c.refText ?? null}, ${c.audience ?? null}, ${c.onlyAdminsPost ?? false}, ${c.membersCanAdd ?? false},
              ${c.directKey ?? null}, ${c.by.kind}, ${c.by.id}::uuid, ${now}, ${now}, ${c.groupType && c.groupType !== "MANUAL" ? now : null})
      ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL DO NOTHING RETURNING id`;
    return rows[0]?.id ?? null;
  }
  async updateGroup(id: string, g: { title: string; description: string | null; onlyAdminsPost: boolean; membersCanAdd: boolean }, now: Date) {
    await this.db.$executeRaw`UPDATE conversations SET title = ${g.title}, description = ${g.description}, only_admins_post = ${g.onlyAdminsPost}, members_can_add = ${g.membersCanAdd}, updated_at = ${now} WHERE id = ${id}::uuid`;
  }
  async markSynced(id: string, now: Date) {
    await this.db.$executeRaw`UPDATE conversations SET synced_at = ${now} WHERE id = ${id}::uuid`;
  }
  /** Os grupos ligados (para a sincronização periódica). */
  async linkedGroups() {
    return this.db.$queryRaw<{ id: string }[]>`SELECT id FROM conversations WHERE kind = 'GROUP' AND group_type IS NOT NULL AND group_type <> 'MANUAL' ORDER BY synced_at NULLS FIRST LIMIT 200`;
  }

  // ================================================================ membros

  async members(id: string): Promise<MemberRow[]> {
    return this.db.$queryRaw<MemberRow[]>`${M_SQL} WHERE conversation_id = ${id}::uuid ORDER BY left_at IS NOT NULL, role, member_name`;
  }
  async member(id: string, p: Party): Promise<MemberRow | null> {
    const [r] = await this.db.$queryRaw<MemberRow[]>`${M_SQL} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid`;
    return r ?? null;
  }
  /** Junta (ou volta a juntar) uma pessoa. Devolve true se entrou agora. */
  async addMember(id: string, c: Contact, role: "ADMIN" | "MEMBER", source: "MANUAL" | "SYNC", now: Date) {
    const rows = await this.db.$queryRaw<{ x: number }[]>`
      INSERT INTO conversation_members (conversation_id, member_kind, member_id, member_name, label, role, source, joined_at)
      VALUES (${id}::uuid, ${c.kind}, ${c.id}::uuid, ${c.name}, ${c.label || null}, ${role}, ${source}, ${now})
      ON CONFLICT (conversation_id, member_kind, member_id) DO UPDATE SET left_at = NULL, joined_at = ${now}, source = EXCLUDED.source, label = coalesce(EXCLUDED.label, conversation_members.label), archived = false
        WHERE conversation_members.left_at IS NOT NULL
      RETURNING 1 AS x`;
    return rows.length > 0;
  }
  async refreshLabel(id: string, p: Party, label: string) {
    await this.db.$executeRaw`UPDATE conversation_members SET label = ${label} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid AND left_at IS NULL AND label IS DISTINCT FROM ${label}`;
  }
  /** Sai (por vontade, removido, ou a sincronização): o histórico fica, até ao momento em que saiu. */
  async removeMember(id: string, p: Party, source: "MANUAL" | "SYNC", now: Date) {
    return this.db.$executeRaw`UPDATE conversation_members SET left_at = ${now}, role = 'MEMBER', source = ${source} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid AND left_at IS NULL`;
  }
  async setRole(id: string, p: Party, role: "ADMIN" | "MEMBER") {
    return this.db.$executeRaw`UPDATE conversation_members SET role = ${role} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid AND left_at IS NULL`;
  }
  async setArchived(id: string, p: Party, archived: boolean) {
    return this.db.$executeRaw`UPDATE conversation_members SET archived = ${archived} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid`;
  }
  async markRead(id: string, p: Party, now: Date) {
    await this.db.$executeRaw`UPDATE conversation_members SET last_read_at = greatest(coalesce(last_read_at, ${now}), ${now}), delivered_at = ${now} WHERE conversation_id = ${id}::uuid AND member_kind = ${p.kind} AND member_id = ${p.id}::uuid`;
  }
  /** Entregue: a pessoa abriu a lista ou a conversa (o portal foi buscar as mensagens). */
  async markDelivered(p: Party, now: Date) {
    await this.db.$executeRaw`UPDATE conversation_members SET delivered_at = ${now} WHERE member_kind = ${p.kind} AND member_id = ${p.id}::uuid AND left_at IS NULL`;
  }

  // ================================================================ listas e mensagens

  /** As conversas da pessoa (incluindo os grupos de onde saiu, só para ler o que lá ficou). */
  async list(p: Party, f: { archived: boolean; q: string | null }) {
    const like = f.q ? `%${f.q}%` : null;
    return this.db.$queryRaw<
      (ConversationRow & { role: string; leftAt: Date | null; archived: boolean; unread: number; members: number; other: string | null; otherLabel: string | null; otherParty: string | null; lastBody: string | null; lastSender: string | null; lastKind: string | null; lastAt: Date | null })[]
    >`
      SELECT x.*, m.role, m.left_at AS "leftAt", m.archived,
             (SELECT count(*)::int FROM messages ms WHERE ms.conversation_id = x.id AND ms.kind = 'TEXT' AND ms.created_at > greatest(coalesce(m.last_read_at, m.joined_at), m.joined_at)
                AND (m.left_at IS NULL OR ms.created_at <= m.left_at) AND NOT (ms.sender_kind = ${p.kind} AND ms.sender_id = ${p.id}::uuid)) AS unread,
             (SELECT count(*)::int FROM conversation_members o WHERE o.conversation_id = x.id AND o.left_at IS NULL) AS members,
             (SELECT o.member_name FROM conversation_members o WHERE x.kind = 'DIRECT' AND o.conversation_id = x.id AND NOT (o.member_kind = ${p.kind} AND o.member_id = ${p.id}::uuid) LIMIT 1) AS other,
             (SELECT o.label FROM conversation_members o WHERE x.kind = 'DIRECT' AND o.conversation_id = x.id AND NOT (o.member_kind = ${p.kind} AND o.member_id = ${p.id}::uuid) LIMIT 1) AS "otherLabel",
             (SELECT o.member_kind || ':' || o.member_id FROM conversation_members o WHERE x.kind = 'DIRECT' AND o.conversation_id = x.id AND NOT (o.member_kind = ${p.kind} AND o.member_id = ${p.id}::uuid) LIMIT 1) AS "otherParty",
             l.body AS "lastBody", l.sender_name AS "lastSender", l.kind AS "lastKind", l.created_at AS "lastAt"
        FROM conversation_members m JOIN (${C_SQL}) x ON x.id = m.conversation_id
        LEFT JOIN LATERAL (SELECT body, sender_name, kind, created_at FROM messages ms WHERE ms.conversation_id = x.id AND ms.created_at >= m.joined_at AND (m.left_at IS NULL OR ms.created_at <= m.left_at) ORDER BY created_at DESC LIMIT 1) l ON true
       WHERE m.member_kind = ${p.kind} AND m.member_id = ${p.id}::uuid AND m.archived = ${f.archived}
         AND (x.kind = 'GROUP' OR x."lastMessageAt" IS NOT NULL OR x."createdById" = ${p.id}::uuid)
         AND (${like}::text IS NULL OR x.title ILIKE ${like} OR EXISTS (SELECT 1 FROM conversation_members o WHERE o.conversation_id = x.id AND o.member_name ILIKE ${like}))
       ORDER BY coalesce(x."lastMessageAt", x."createdAt") DESC LIMIT 100`;
  }
  async unreadTotal(p: Party) {
    const [r] = await this.db.$queryRaw<{ n: number; conversations: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT m.conversation_id)::int AS conversations FROM conversation_members m JOIN messages ms ON ms.conversation_id = m.conversation_id
       WHERE m.member_kind = ${p.kind} AND m.member_id = ${p.id}::uuid AND ms.kind = 'TEXT' AND ms.created_at > greatest(coalesce(m.last_read_at, m.joined_at), m.joined_at)
         AND (m.left_at IS NULL OR ms.created_at <= m.left_at) AND NOT (ms.sender_kind = ${p.kind} AND ms.sender_id = ${p.id}::uuid)`;
    return r ?? { n: 0, conversations: 0 };
  }
  /** As mensagens que a pessoa pode ler (desde que entrou, até sair): as mais recentes, antes ou depois de um ponto. */
  async messages(id: string, window: { from: Date; to: Date | null }, cursor: { before?: Date | null; after?: Date | null }, limit = 50): Promise<MessageRow[]> {
    const rows = await this.db.$queryRaw<MessageRow[]>`
      SELECT id, kind, sender_kind AS "senderKind", sender_id AS "senderId", sender_name AS "senderName", body, created_at AS "createdAt" FROM messages
       WHERE conversation_id = ${id}::uuid AND created_at >= ${window.from} AND (${window.to}::timestamp IS NULL OR created_at <= ${window.to}::timestamp)
         AND (${cursor.before ?? null}::timestamp IS NULL OR created_at < ${cursor.before ?? null}::timestamp)
         AND (${cursor.after ?? null}::timestamp IS NULL OR created_at > ${cursor.after ?? null}::timestamp)
       ORDER BY created_at ${cursor.after ? Prisma.sql`ASC` : Prisma.sql`DESC`}, id LIMIT ${limit}`;
    return cursor.after ? rows : rows.reverse();
  }
  async files(messageIds: string[]): Promise<FileRow[]> {
    if (!messageIds.length) return [];
    return this.db.$queryRaw<FileRow[]>`SELECT id, message_id AS "messageId", file_name AS "fileName", mime_type AS "mimeType", size, storage_key AS "storageKey" FROM message_files WHERE message_id = ANY(${messageIds}::uuid[]) ORDER BY created_at`;
  }
  async file(conversationId: string, fileId: string) {
    const [r] = await this.db.$queryRaw<(FileRow & { createdAt: Date })[]>`
      SELECT f.id, f.message_id AS "messageId", f.file_name AS "fileName", f.mime_type AS "mimeType", f.size, f.storage_key AS "storageKey", m.created_at AS "createdAt"
        FROM message_files f JOIN messages m ON m.id = f.message_id WHERE f.id = ${fileId}::uuid AND f.conversation_id = ${conversationId}::uuid`;
    return r ?? null;
  }
  async addMessage(id: string, m: { kind: "TEXT" | "SYSTEM"; sender: (Party & { name: string }) | null; body: string }, now: Date) {
    const mid = randomUUID();
    await this.db.$executeRaw`INSERT INTO messages (id, conversation_id, kind, sender_kind, sender_id, sender_name, body, created_at)
                              VALUES (${mid}::uuid, ${id}::uuid, ${m.kind}, ${m.sender?.kind ?? null}, ${m.sender?.id ?? null}::uuid, ${m.sender?.name ?? null}, ${m.body}, ${now})`;
    if (m.kind === "TEXT") {
      await this.db.$executeRaw`UPDATE conversations SET last_message_at = ${now}, updated_at = ${now} WHERE id = ${id}::uuid`;
      // quem tinha arquivado volta a ver a conversa
      await this.db.$executeRaw`UPDATE conversation_members SET archived = false WHERE conversation_id = ${id}::uuid AND left_at IS NULL AND archived`;
    }
    return mid;
  }
  async addFile(id: string, messageId: string, f: { fileName: string; mimeType: string; size: number; sha256: string; storageKey: string }, now: Date) {
    await this.db.$executeRaw`INSERT INTO message_files (id, message_id, conversation_id, file_name, mime_type, size, sha256, storage_key, created_at)
                              VALUES (${randomUUID()}::uuid, ${messageId}::uuid, ${id}::uuid, ${f.fileName}, ${f.mimeType}, ${f.size}, ${f.sha256}, ${f.storageKey}, ${now})`;
  }
  /** Os outros membros ativos que ainda não tinham nada por ler (a notificação vai só a esses: uma até lerem). */
  async toNotify(id: string, sender: Party, before: Date) {
    return this.db.$queryRaw<Party[]>`
      SELECT m.member_kind AS kind, m.member_id AS id FROM conversation_members m
       WHERE m.conversation_id = ${id}::uuid AND m.left_at IS NULL AND NOT (m.member_kind = ${sender.kind} AND m.member_id = ${sender.id}::uuid)
         AND NOT EXISTS (SELECT 1 FROM messages ms WHERE ms.conversation_id = m.conversation_id AND ms.kind = 'TEXT' AND ms.created_at < ${before}
                           AND ms.created_at > greatest(coalesce(m.last_read_at, m.joined_at), m.joined_at) AND NOT (ms.sender_kind = m.member_kind AND ms.sender_id = m.member_id))`;
  }
}
