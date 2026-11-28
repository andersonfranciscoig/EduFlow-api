import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { gradeLabel } from "../../pedagogy/domain/academic";
import type { AnnouncementInput, GroupAudience, Priority, Scope, Status, Target, TargetKind } from "../domain/announcements";

type Db = PrismaClient | Prisma.TransactionClient;
/** o assunto das alterações à configuração da comunicação na atividade do colégio */
const SETTINGS_SUBJECT = "00000000-0000-0000-0000-0000000000cc";

export interface Actor {
  id: string;
  name: string;
}
export type RecipientKind = "STAFF" | "FAMILY";
export interface Recipient {
  kind: RecipientKind;
  id: string;
  name: string;
  via: string;
}
export interface AnnouncementRow {
  id: string;
  number: number;
  title: string;
  body: string;
  categoryId: string;
  categoryName: string;
  priority: Priority;
  status: Status;
  scope: Scope;
  publishAt: Date | null;
  publishedAt: Date | null;
  expiresAt: Date | null;
  pinned: boolean;
  requiresAck: boolean;
  authorId: string;
  authorName: string;
  revision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface TargetRow extends Target {
  id: string;
  label: string | null;
}
export interface FileRow {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  createdAt: Date;
}
export interface GroupOption {
  id: string;
  label: string;
  classId: string;
  yearName: string;
}

const A_SQL = Prisma.sql`
  SELECT a.id, a.number, a.title, a.body, a.category_id AS "categoryId", c.name AS "categoryName", a.priority, a.status, a.scope,
         a.publish_at AS "publishAt", a.published_at AS "publishedAt", a.expires_at AS "expiresAt", a.pinned, a.requires_ack AS "requiresAck",
         a.author_id AS "authorId", a.author_name AS "authorName", a.revision, a.archived_at AS "archivedAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt"
    FROM announcements a JOIN announcement_categories c ON c.id = a.category_id`;
/** as matrículas que contam: ativas, em anos letivos que não terminaram */
const LIVE = Prisma.sql`e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM academic_years y WHERE y.id = e.academic_year_id AND y.status <> 'CLOSED')`;
const classLabel = (grade: number | null, course: string | null) => (grade === null ? "—" : `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`);

/** Avisos: a configuração, as categorias, os avisos, quem os recebe e os anexos (BD do colégio). */
export class PrismaAnnouncementsRepository {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaAnnouncementsRepository(db);
  }
  async transaction<T>(fn: (repo: PrismaAnnouncementsRepository) => Promise<T>): Promise<T> {
    return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaAnnouncementsRepository(tx)), { timeout: 30_000 });
  }
  async activity(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  // ================================================================ configuração e categorias

  async settings() {
    const [r] = await this.db.$queryRaw<{ classDirectorsPublish: boolean; updatedByName: string | null; updatedAt: Date | null }[]>`
      SELECT class_directors_publish AS "classDirectorsPublish", updated_by_name AS "updatedByName", updated_at AS "updatedAt" FROM communication_settings WHERE id = 1`;
    return r ?? { classDirectorsPublish: true, updatedByName: null, updatedAt: null };
  }
  async saveSettings(s: { classDirectorsPublish: boolean }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO communication_settings (id, class_directors_publish, updated_by_id, updated_by_name, updated_at) VALUES (1, ${s.classDirectorsPublish}, ${actor.id}::uuid, ${actor.name}, ${now})
      ON CONFLICT (id) DO UPDATE SET class_directors_publish = EXCLUDED.class_directors_publish, updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`;
    await this.activity("communication.settings", SETTINGS_SUBJECT, actor.id, { ...s }, now);
  }
  async categories(includeArchived = false) {
    return this.db.$queryRaw<{ id: string; name: string; position: number; archived: boolean; used: number }[]>`
      SELECT c.id, c.name, c.position, c.archived_at IS NOT NULL AS archived, (SELECT count(*)::int FROM announcements a WHERE a.category_id = c.id) AS used
        FROM announcement_categories c WHERE ${includeArchived} OR c.archived_at IS NULL ORDER BY c.archived_at IS NOT NULL, c.position, c.name`;
  }
  async category(id: string) {
    const [r] = await this.db.$queryRaw<{ id: string; name: string; archived: boolean }[]>`SELECT id, name, archived_at IS NOT NULL AS archived FROM announcement_categories WHERE id = ${id}::uuid`;
    return r ?? null;
  }
  async categoryByName(name: string) {
    const [r] = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM announcement_categories WHERE lower(name) = lower(${name})`;
    return r?.id ?? null;
  }
  async addCategory(name: string, now: Date) {
    const id = randomUUID();
    await this.db.$executeRaw`INSERT INTO announcement_categories (id, name, position, created_at) VALUES (${id}::uuid, ${name}, (SELECT coalesce(max(position), 0) + 1 FROM announcement_categories), ${now})`;
    return id;
  }
  async updateCategory(id: string, c: { name: string; archived: boolean }, now: Date) {
    await this.db.$executeRaw`UPDATE announcement_categories SET name = ${c.name}, archived_at = CASE WHEN ${c.archived} THEN coalesce(archived_at, ${now}) ELSE NULL END WHERE id = ${id}::uuid`;
  }

  // ================================================================ quem publica

  /** As turmas de que o utilizador é diretor de turma (anos letivos que não terminaram). */
  async coordinatedGroups(userId: string): Promise<GroupOption[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string; classId: string; grade: number | null; course: string | null; yearName: string }[]>`
      SELECT g.id, g.name, g.class_id AS "classId", c.grade, co.name AS course, y.name AS "yearName"
        FROM class_groups g JOIN employees emp ON emp.id = g.coordinator_id JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
        JOIN academic_years y ON y.id = g.academic_year_id
       WHERE emp.user_id = ${userId}::uuid AND y.status <> 'CLOSED' ORDER BY y.starts_on DESC, c.grade, g.name`;
    return rows.map((r) => ({ id: r.id, label: `${classLabel(r.grade, r.course)} · ${r.name}`, classId: r.classId, yearName: r.yearName }));
  }
  /** As classes e turmas dos anos letivos que não terminaram, e os departamentos das fichas (para escolher destinatários). */
  async options() {
    const [classes, groups, departments] = await Promise.all([
      this.db.$queryRaw<{ id: string; grade: number | null; course: string | null; yearName: string }[]>`
        SELECT c.id, c.grade, co.name AS course, y.name AS "yearName" FROM school_classes c LEFT JOIN courses co ON co.id = c.course_id JOIN academic_years y ON y.id = c.academic_year_id
         WHERE y.status <> 'CLOSED' ORDER BY y.starts_on DESC, c.grade, co.name NULLS FIRST`,
      this.db.$queryRaw<{ id: string; name: string; classId: string; grade: number | null; course: string | null; yearName: string }[]>`
        SELECT g.id, g.name, g.class_id AS "classId", c.grade, co.name AS course, y.name AS "yearName"
          FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id JOIN academic_years y ON y.id = g.academic_year_id
         WHERE y.status <> 'CLOSED' ORDER BY y.starts_on DESC, c.grade, g.name`,
      this.db.$queryRaw<{ name: string }[]>`
        SELECT DISTINCT ON (lower(d)) d AS name FROM (
          SELECT btrim(department) AS d FROM employees WHERE coalesce(btrim(department), '') <> '' AND status <> 'TERMINATED'
          UNION ALL SELECT btrim(department) FROM employee_contracts WHERE coalesce(btrim(department), '') <> ''
        ) x ORDER BY lower(d), d`,
    ]);
    return {
      classes: classes.map((c) => ({ id: c.id, label: classLabel(c.grade, c.course), yearName: c.yearName })),
      groups: groups.map((g) => ({ id: g.id, label: `${classLabel(g.grade, g.course)} · ${g.name}`, classId: g.classId, yearName: g.yearName })),
      departments: departments.map((d) => d.name),
    };
  }
  /** Pessoas para escolher: contas da equipa e, com toda a comunidade, contas da família. */
  async searchPeople(q: string, family: boolean) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const staff = await this.db.$queryRaw<{ id: string; name: string; hint: string }[]>`
      SELECT u.id, u.full_name AS name, u.role::text AS hint FROM school_users u WHERE u.status = 'ACTIVE' AND (u.full_name ILIKE ${like} OR u.email ILIKE ${like}) ORDER BY u.full_name LIMIT 15`;
    const fam = family
      ? await this.db.$queryRaw<{ id: string; name: string; hint: string }[]>`
          SELECT fa.id, fa.full_name AS name, fa.kind AS hint FROM family_accounts fa WHERE fa.status = 'ACTIVE' AND (fa.full_name ILIKE ${like} OR fa.email ILIKE ${like}) ORDER BY fa.full_name LIMIT 15`
      : [];
    return { staff, family: fam };
  }
  /** Os nomes dos destinatários escolhidos (classes, turmas e pessoas), para mostrar. */
  async targetLabels(targets: Target[]) {
    const ids = targets.map((t) => t.refId).filter((x): x is string => !!x);
    if (!ids.length) return new Map<string, string>();
    const rows = await this.db.$queryRaw<{ id: string; label: string }[]>`
      SELECT c.id::text, c.grade::text || '|' || coalesce(co.name, '') AS label FROM school_classes c LEFT JOIN courses co ON co.id = c.course_id WHERE c.id = ANY(${ids}::uuid[])
      UNION ALL SELECT g.id::text, 'G|' || c.grade::text || '|' || coalesce(co.name, '') || '|' || g.name FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id WHERE g.id = ANY(${ids}::uuid[])
      UNION ALL SELECT id::text, 'P|' || full_name FROM school_users WHERE id = ANY(${ids}::uuid[])
      UNION ALL SELECT id::text, 'P|' || full_name FROM family_accounts WHERE id = ANY(${ids}::uuid[])`;
    const out = new Map<string, string>();
    for (const r of rows) {
      const p = r.label.split("|");
      if (p[0] === "P") out.set(r.id, p.slice(1).join("|"));
      else if (p[0] === "G") out.set(r.id, `${classLabel(Number(p[1]), p[2] || null)} · ${p.slice(3).join("|")}`);
      else out.set(r.id, classLabel(Number(p[0]), p[1] || null));
    }
    return out;
  }

  // ================================================================ destinatários (expansão, sem repetidos)

  private async students(where: Prisma.Sql, via: string): Promise<Recipient[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT DISTINCT fa.id, fa.full_name AS name FROM enrollments e JOIN students s ON s.id = e.student_id JOIN family_accounts fa ON fa.id = s.account_id
       WHERE ${LIVE} AND fa.status = 'ACTIVE' AND fa.kind = 'STUDENT' AND ${where}`;
    return rows.map((r) => ({ kind: "FAMILY", id: r.id, name: r.name, via }));
  }
  private async guardians(where: Prisma.Sql, via: string): Promise<Recipient[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT DISTINCT fa.id, fa.full_name AS name FROM enrollments e JOIN student_guardians sg ON sg.student_id = e.student_id JOIN guardians gd ON gd.id = sg.guardian_id
        JOIN family_accounts fa ON fa.id = gd.account_id
       WHERE ${LIVE} AND fa.status = 'ACTIVE' AND ${where}`;
    return rows.map((r) => ({ kind: "FAMILY", id: r.id, name: r.name, via }));
  }
  private async users(where: Prisma.Sql, via: string): Promise<Recipient[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`SELECT u.id, u.full_name AS name FROM school_users u WHERE u.status = 'ACTIVE' AND ${where}`;
    return rows.map((r) => ({ kind: "STAFF", id: r.id, name: r.name, via }));
  }
  private async family(over: string[], via: string): Promise<Recipient[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`SELECT id, full_name AS name FROM family_accounts WHERE status = 'ACTIVE' AND id = ANY(${over}::uuid[])`;
    return rows.map((r) => ({ kind: "FAMILY", id: r.id, name: r.name, via }));
  }
  /** Quem recebe: cada pessoa uma vez (a primeira razão por que o recebe fica como "via"). */
  async expand(targets: Target[], labels: Map<string, string>): Promise<Recipient[]> {
    const all: Recipient[] = [];
    const teachers = Prisma.sql`(u.role = 'PROFESSOR' OR EXISTS (SELECT 1 FROM employees emp WHERE emp.user_id = u.id AND (EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.employee_id = emp.id) OR EXISTS (SELECT 1 FROM class_groups cg WHERE cg.coordinator_id = emp.id))))`;
    for (const t of targets) {
      const k: TargetKind = t.kind;
      const name = t.refId ? (labels.get(t.refId) ?? "") : "";
      const byAudience = async (where: Prisma.Sql, a: GroupAudience | null | undefined) => {
        if (a !== "GUARDIANS") all.push(...(await this.students(where, `Aluno · ${name}`)));
        if (a !== "STUDENTS") all.push(...(await this.guardians(where, `Encarregado · ${name}`)));
      };
      if (k === "ALL") {
        all.push(...(await this.users(Prisma.sql`true`, "Equipa")), ...(await this.students(Prisma.sql`true`, "Aluno")), ...(await this.guardians(Prisma.sql`true`, "Encarregado")));
      } else if (k === "STUDENTS") all.push(...(await this.students(Prisma.sql`true`, "Aluno")));
      else if (k === "GUARDIANS") all.push(...(await this.guardians(Prisma.sql`true`, "Encarregado")));
      else if (k === "TEACHERS") all.push(...(await this.users(teachers, "Professor")));
      else if (k === "STAFF") all.push(...(await this.users(Prisma.sql`u.role <> 'PROFESSOR'`, "Funcionário")));
      else if (k === "CLASS") await byAudience(Prisma.sql`e.class_id = ${t.refId}::uuid`, t.audience);
      else if (k === "GROUP") await byAudience(Prisma.sql`e.group_id = ${t.refId}::uuid`, t.audience);
      else if (k === "DEPARTMENT")
        all.push(
          ...(await this.users(
            Prisma.sql`EXISTS (SELECT 1 FROM employees emp WHERE emp.user_id = u.id AND emp.status <> 'TERMINATED' AND (lower(btrim(emp.department)) = lower(${t.refText}) OR EXISTS (SELECT 1 FROM employee_contracts ec WHERE ec.employee_id = emp.id AND lower(btrim(ec.department)) = lower(${t.refText}))))`,
            `Departamento · ${t.refText}`,
          )),
        );
      else if (k === "USER") all.push(...(await this.users(Prisma.sql`u.id = ${t.refId}::uuid`, "Escolhido")));
      else if (k === "FAMILY") all.push(...(await this.family([t.refId!], "Escolhido")));
    }
    const out = new Map<string, Recipient>();
    for (const r of all) if (!out.has(`${r.kind}|${r.id}`)) out.set(`${r.kind}|${r.id}`, r);
    return [...out.values()];
  }

  // ================================================================ avisos

  async create(a: Omit<AnnouncementInput, "targets"> & { scope: Scope; status: Status }, targets: Target[], actor: Actor, now: Date) {
    const id = randomUUID();
    await this.db.$executeRaw`
      INSERT INTO announcements (id, title, body, category_id, priority, status, scope, publish_at, expires_at, pinned, requires_ack, author_id, author_name, created_at, updated_at)
      VALUES (${id}::uuid, ${a.title}, ${a.body}, ${a.categoryId}::uuid, ${a.priority}, ${a.status}, ${a.scope}, ${a.publishAt}::timestamp, ${a.expiresAt}::timestamp, ${a.pinned}, ${a.requiresAck}, ${actor.id}::uuid, ${actor.name}, ${now}, ${now})`;
    await this.setTargets(id, targets);
    return id;
  }
  async update(id: string, revision: number, a: Omit<AnnouncementInput, "targets"> & { scope: Scope; status: Status }, targets: Target[], now: Date) {
    const n = await this.db.$executeRaw`
      UPDATE announcements SET title = ${a.title}, body = ${a.body}, category_id = ${a.categoryId}::uuid, priority = ${a.priority}, status = ${a.status}, scope = ${a.scope},
             publish_at = ${a.publishAt}::timestamp, expires_at = ${a.expiresAt}::timestamp, pinned = ${a.pinned}, requires_ack = ${a.requiresAck}, revision = revision + 1, updated_at = ${now}
       WHERE id = ${id}::uuid AND revision = ${revision} AND status IN ('DRAFT', 'SCHEDULED')`;
    if (!n) return false;
    await this.db.$executeRaw`DELETE FROM announcement_targets WHERE announcement_id = ${id}::uuid`;
    await this.setTargets(id, targets);
    return true;
  }
  private async setTargets(id: string, targets: Target[]) {
    for (const t of targets)
      await this.db.$executeRaw`INSERT INTO announcement_targets (id, announcement_id, kind, ref_id, ref_text, audience) VALUES (${randomUUID()}::uuid, ${id}::uuid, ${t.kind}, ${t.refId ?? null}::uuid, ${t.refText ?? null}, ${t.audience ?? null})`;
  }
  /** Os publicados já não se editam; só a expiração, fixar e arquivar. */
  async patchPublished(id: string, p: { pinned?: boolean; expiresAt?: string | null }, now: Date) {
    await this.db.$executeRaw`UPDATE announcements SET pinned = coalesce(${p.pinned ?? null}, pinned), expires_at = CASE WHEN ${p.expiresAt !== undefined} THEN ${p.expiresAt ?? null}::timestamp ELSE expires_at END, revision = revision + 1, updated_at = ${now} WHERE id = ${id}::uuid AND status = 'PUBLISHED'`;
  }
  async get(id: string): Promise<AnnouncementRow | null> {
    const [r] = await this.db.$queryRaw<AnnouncementRow[]>`${A_SQL} WHERE a.id = ${id}::uuid`;
    return r ?? null;
  }
  async targets(id: string): Promise<Target[]> {
    return this.db.$queryRaw<Target[]>`SELECT kind, ref_id AS "refId", ref_text AS "refText", audience FROM announcement_targets WHERE announcement_id = ${id}::uuid ORDER BY kind, ref_text`;
  }
  /** A gestão: todos (com a permissão de gerir) ou só os do autor. */
  async list(f: { authorId: string | null; status: Status | null; categoryId: string | null; q: string | null; page: number }, now: Date) {
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (f.authorId) conds.push(Prisma.sql`a.author_id = ${f.authorId}::uuid`);
    if (f.status) conds.push(Prisma.sql`a.status = ${f.status}`);
    if (f.categoryId) conds.push(Prisma.sql`a.category_id = ${f.categoryId}::uuid`);
    if (f.q) conds.push(Prisma.sql`(a.title ILIKE ${`%${f.q}%`} OR a.body ILIKE ${`%${f.q}%`})`);
    const where = Prisma.join(conds, " AND ");
    const rows = await this.db.$queryRaw<(AnnouncementRow & { recipients: number; viewed: number; acknowledged: number; expired: boolean })[]>`
      SELECT x.*, (SELECT count(*)::int FROM announcement_recipients r WHERE r.announcement_id = x.id) AS recipients,
             (SELECT count(*)::int FROM announcement_recipients r WHERE r.announcement_id = x.id AND r.viewed_at IS NOT NULL) AS viewed,
             (SELECT count(*)::int FROM announcement_recipients r WHERE r.announcement_id = x.id AND r.acknowledged_at IS NOT NULL) AS acknowledged,
             (x."expiresAt" IS NOT NULL AND x."expiresAt" <= ${now}) AS expired
        FROM (${A_SQL} WHERE ${where}) x
       ORDER BY (x.status = 'DRAFT') DESC, coalesce(x."publishedAt", x."publishAt", x."updatedAt") DESC LIMIT 30 OFFSET ${(f.page - 1) * 30}`;
    const [{ total }] = await this.db.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM announcements a WHERE ${where}`;
    return { rows, total };
  }
  /** Os avisos de uma pessoa (publicados e por expirar): fixados primeiro, depois os mais recentes. */
  async inbox(who: { kind: RecipientKind; id: string }, f: { categoryId: string | null; q: string | null; unread: boolean; page: number }, now: Date) {
    const conds: Prisma.Sql[] = [Prisma.sql`r.recipient_kind = ${who.kind} AND r.recipient_id = ${who.id}::uuid AND x.status = 'PUBLISHED' AND (x."expiresAt" IS NULL OR x."expiresAt" > ${now})`];
    if (f.categoryId) conds.push(Prisma.sql`x."categoryId" = ${f.categoryId}::uuid`);
    if (f.q) conds.push(Prisma.sql`(x.title ILIKE ${`%${f.q}%`} OR x.body ILIKE ${`%${f.q}%`})`);
    if (f.unread) conds.push(Prisma.sql`r.viewed_at IS NULL`);
    const where = Prisma.join(conds, " AND ");
    const rows = await this.db.$queryRaw<(AnnouncementRow & { viewedAt: Date | null; acknowledgedAt: Date | null; files: number })[]>`
      SELECT x.*, r.viewed_at AS "viewedAt", r.acknowledged_at AS "acknowledgedAt", (SELECT count(*)::int FROM announcement_files f WHERE f.announcement_id = x.id) AS files
        FROM announcement_recipients r JOIN (${A_SQL}) x ON x.id = r.announcement_id
       WHERE ${where} ORDER BY x.pinned DESC, x."publishedAt" DESC LIMIT 30 OFFSET ${(f.page - 1) * 30}`;
    const [c] = await this.db.$queryRaw<{ total: number; unread: number; pending: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE r.viewed_at IS NULL)::int AS unread, count(*) FILTER (WHERE x."requiresAck" AND r.acknowledged_at IS NULL)::int AS pending
        FROM announcement_recipients r JOIN (${A_SQL}) x ON x.id = r.announcement_id WHERE ${where}`;
    return { rows, ...c };
  }
  async unread(who: { kind: RecipientKind; id: string }, now: Date) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM announcement_recipients r JOIN announcements a ON a.id = r.announcement_id
       WHERE r.recipient_kind = ${who.kind} AND r.recipient_id = ${who.id}::uuid AND r.viewed_at IS NULL AND a.status = 'PUBLISHED' AND (a.expires_at IS NULL OR a.expires_at > ${now})`;
    return r?.n ?? 0;
  }
  async recipient(id: string, who: { kind: RecipientKind; id: string }) {
    const [r] = await this.db.$queryRaw<{ viewedAt: Date | null; acknowledgedAt: Date | null; deliveredAt: Date | null }[]>`
      SELECT viewed_at AS "viewedAt", acknowledged_at AS "acknowledgedAt", delivered_at AS "deliveredAt" FROM announcement_recipients
       WHERE announcement_id = ${id}::uuid AND recipient_kind = ${who.kind} AND recipient_id = ${who.id}::uuid`;
    return r ?? null;
  }
  async markViewed(id: string, who: { kind: RecipientKind; id: string }, now: Date) {
    await this.db.$executeRaw`UPDATE announcement_recipients SET viewed_at = coalesce(viewed_at, ${now}) WHERE announcement_id = ${id}::uuid AND recipient_kind = ${who.kind} AND recipient_id = ${who.id}::uuid`;
  }
  async acknowledge(id: string, who: { kind: RecipientKind; id: string }, now: Date) {
    return this.db.$executeRaw`UPDATE announcement_recipients SET viewed_at = coalesce(viewed_at, ${now}), acknowledged_at = coalesce(acknowledged_at, ${now})
                                WHERE announcement_id = ${id}::uuid AND recipient_kind = ${who.kind} AND recipient_id = ${who.id}::uuid`;
  }
  /** Publica (uma vez: só sai de rascunho ou agendado) e grava quem recebe. Devolve false se outro já publicou. */
  async publish(id: string, recipients: Recipient[], now: Date) {
    const n = await this.db.$executeRaw`UPDATE announcements SET status = 'PUBLISHED', published_at = ${now}, publish_at = NULL, revision = revision + 1, updated_at = ${now} WHERE id = ${id}::uuid AND status IN ('DRAFT', 'SCHEDULED')`;
    if (!n) return false;
    for (let i = 0; i < recipients.length; i += 500) {
      const chunk = recipients.slice(i, i + 500);
      await this.db.$executeRaw`
        INSERT INTO announcement_recipients (announcement_id, recipient_kind, recipient_id, recipient_name, via)
        SELECT ${id}::uuid, k, rid, nm, v FROM unnest(${chunk.map((r) => r.kind)}::text[], ${chunk.map((r) => r.id)}::uuid[], ${chunk.map((r) => r.name)}::text[], ${chunk.map((r) => r.via)}::text[]) AS t(k, rid, nm, v)
        ON CONFLICT DO NOTHING`;
    }
    return true;
  }
  /** Entregue = a notificação chegou de facto à plataforma (o colégio pode ter desligado o tipo). */
  async markDeliveredFromNotifications(id: string, now: Date) {
    await this.db.$executeRaw`
      UPDATE announcement_recipients r SET delivered_at = coalesce(r.delivered_at, ${now})
       WHERE r.announcement_id = ${id}::uuid AND r.recipient_kind = 'STAFF'
         AND EXISTS (SELECT 1 FROM staff_notifications n WHERE n.user_id = r.recipient_id AND n.dedupe_key = ${`announcement:${id}`})`;
    await this.db.$executeRaw`
      UPDATE announcement_recipients r SET delivered_at = coalesce(r.delivered_at, ${now})
       WHERE r.announcement_id = ${id}::uuid AND r.recipient_kind = 'FAMILY'
         AND EXISTS (SELECT 1 FROM family_notifications n WHERE n.account_id = r.recipient_id AND n.kind = 'FAMILY_ANNOUNCEMENTS' AND n.link = ${`/familia/avisos/${id}`})`;
  }
  async unschedule(id: string, now: Date) {
    await this.db.$executeRaw`UPDATE announcements SET status = 'DRAFT', revision = revision + 1, updated_at = ${now} WHERE id = ${id}::uuid AND status = 'SCHEDULED'`;
  }
  async archive(id: string, now: Date) {
    return this.db.$executeRaw`UPDATE announcements SET status = 'ARCHIVED', archived_at = ${now}, pinned = false, revision = revision + 1, updated_at = ${now} WHERE id = ${id}::uuid AND status <> 'ARCHIVED'`;
  }
  async remove(id: string) {
    return this.db.$executeRaw`DELETE FROM announcements WHERE id = ${id}::uuid AND status = 'DRAFT'`;
  }
  /** Os agendados cuja hora chegou. */
  async due(now: Date) {
    const rows = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM announcements WHERE status = 'SCHEDULED' AND publish_at <= ${now} ORDER BY publish_at LIMIT 50`;
    return rows.map((r) => r.id);
  }
  /** Indicadores: quantos recebem, viram e confirmaram, e a lista (com filtro). */
  async stats(id: string, filter: "ALL" | "VIEWED" | "NOT_VIEWED" | "ACK" | "NOT_ACK") {
    const [t] = await this.db.$queryRaw<{ total: number; delivered: number; viewed: number; acknowledged: number; staff: number; family: number }[]>`
      SELECT count(*)::int AS total, count(delivered_at)::int AS delivered, count(viewed_at)::int AS viewed, count(acknowledged_at)::int AS acknowledged,
             count(*) FILTER (WHERE recipient_kind = 'STAFF')::int AS staff, count(*) FILTER (WHERE recipient_kind = 'FAMILY')::int AS family
        FROM announcement_recipients WHERE announcement_id = ${id}::uuid`;
    const cond =
      filter === "VIEWED" ? Prisma.sql`viewed_at IS NOT NULL` : filter === "NOT_VIEWED" ? Prisma.sql`viewed_at IS NULL` : filter === "ACK" ? Prisma.sql`acknowledged_at IS NOT NULL` : filter === "NOT_ACK" ? Prisma.sql`acknowledged_at IS NULL` : Prisma.sql`true`;
    const people = await this.db.$queryRaw<{ kind: RecipientKind; id: string; name: string; via: string | null; deliveredAt: Date | null; viewedAt: Date | null; acknowledgedAt: Date | null }[]>`
      SELECT recipient_kind AS kind, recipient_id AS id, recipient_name AS name, via, delivered_at AS "deliveredAt", viewed_at AS "viewedAt", acknowledged_at AS "acknowledgedAt"
        FROM announcement_recipients WHERE announcement_id = ${id}::uuid AND ${cond} ORDER BY viewed_at IS NULL DESC, recipient_name LIMIT 500`;
    return { totals: t, people };
  }

  // ================================================================ anexos

  async files(id: string): Promise<FileRow[]> {
    return this.db.$queryRaw<FileRow[]>`SELECT id, file_name AS "fileName", mime_type AS "mimeType", size, storage_key AS "storageKey", created_at AS "createdAt" FROM announcement_files WHERE announcement_id = ${id}::uuid ORDER BY created_at`;
  }
  async addFile(id: string, f: { fileName: string; mimeType: string; size: number; sha256: string; storageKey: string }, now: Date) {
    await this.db.$executeRaw`INSERT INTO announcement_files (id, announcement_id, file_name, mime_type, size, sha256, storage_key, created_at)
                              VALUES (${randomUUID()}::uuid, ${id}::uuid, ${f.fileName}, ${f.mimeType}, ${f.size}, ${f.sha256}, ${f.storageKey}, ${now})`;
  }
  async removeFile(id: string, fileId: string) {
    return this.db.$executeRaw`DELETE FROM announcement_files WHERE id = ${fileId}::uuid AND announcement_id = ${id}::uuid`;
  }
}
