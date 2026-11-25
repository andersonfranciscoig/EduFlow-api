import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Definition } from "../domain/model";
import type { Rule, Scope } from "../domain/rules";

export interface ModelRow {
  id: string;
  name: string;
  description: string | null;
  draft: Definition | null;
  currentVersion: number | null;
  current: Definition | null;
  revision: number;
  archivedAt: Date | null;
  updatedAt: Date;
  updatedByName: string | null;
  /** regras nos anos letivos ainda abertos / em todos */
  openRules: number;
  rules: number;
}
export interface VersionRow {
  number: number;
  definition: Definition;
  reason: string | null;
  publishedAt: Date;
  publishedByName: string | null;
}
export interface TypeRow {
  id: string;
  name: string;
  archived: boolean;
  /** modelos (rascunho ou em vigor) que o usam */
  used: number;
}
export interface YearRow {
  id: string;
  name: string;
  status: string;
  startsOn: string;
  endsOn: string;
  periodKind: string;
}
export interface ClassRow {
  id: string;
  grade: number;
  courseId: string | null;
  courseName: string | null;
  groups: number;
  subjects: { id: string; name: string; code: string; color: string }[];
}

type Db = PrismaClient | Prisma.TransactionClient;
/** O assunto do histórico dos elementos de avaliação (não têm um modelo a que pertençam). */
export const TYPES_SUBJECT = "00000000-0000-0000-0000-000000000a43";
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || (e.meta as { code?: string } | undefined)?.code === "23505");
const isForeignKey = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2003" || (e.meta as { code?: string } | undefined)?.code === "23503");
const json = (v: unknown) => JSON.stringify(v);
const MODEL = Prisma.raw(`
  SELECT m.id, m.name, m.description, m.draft, m.current_version AS "currentVersion", v.definition AS current, m.revision, m.archived_at AS "archivedAt", m.updated_at AS "updatedAt", u.full_name AS "updatedByName",
         (SELECT count(*)::int FROM grading_rules r JOIN academic_years y ON y.id = r.academic_year_id WHERE r.model_id = m.id AND y.status <> 'CLOSED') AS "openRules",
         (SELECT count(*)::int FROM grading_rules r WHERE r.model_id = m.id) AS rules
    FROM grading_models m LEFT JOIN grading_model_versions v ON v.model_id = m.id AND v.number = m.current_version LEFT JOIN school_users u ON u.id = m.updated_by_id`);

/** Modelos, versões, regras e elementos de avaliação, na BD do colégio. */
export class PrismaGradingSettingsRepository {
  constructor(
    private readonly db: Db,
    private readonly root: PrismaClient | null = null,
  ) {}
  static for(db: PrismaClient) {
    return new PrismaGradingSettingsRepository(db, db);
  }
  /** Alterações às regras de um ano: uma de cada vez (o que se verifica é o que se grava). */
  async locked<T>(yearId: string, work: (repo: PrismaGradingSettingsRepository) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error("já está numa transação");
    return this.root.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grading:${yearId}`}))`;
      return work(new PrismaGradingSettingsRepository(tx));
    });
  }
  private tx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error("precisa da ligação principal");
    return this.root.$transaction(work);
  }

  // ================================================================ modelos

  models(): Promise<ModelRow[]> {
    return this.db.$queryRaw<ModelRow[]>`${MODEL} ORDER BY m.archived_at IS NOT NULL, lower(m.name)`;
  }
  async model(id: string): Promise<ModelRow | null> {
    return (await this.db.$queryRaw<ModelRow[]>`${MODEL} WHERE m.id = ${id}::uuid`)[0] ?? null;
  }
  versions(id: string): Promise<VersionRow[]> {
    return this.db.$queryRaw<VersionRow[]>`
      SELECT v.number, v.definition, v.reason, v.published_at AS "publishedAt", u.full_name AS "publishedByName"
        FROM grading_model_versions v LEFT JOIN school_users u ON u.id = v.published_by_id WHERE v.model_id = ${id}::uuid ORDER BY v.number DESC`;
  }
  /** Onde se aplica, por ano letivo aberto. */
  uses(id: string) {
    return this.db.$queryRaw<{ yearName: string; level: string | null; courseName: string | null; grade: number | null; classCourse: string | null; subjectName: string | null; period: number | null; periodKind: string }[]>`
      SELECT y.name AS "yearName", y.period_kind AS "periodKind", r.level, co.name AS "courseName", c.grade, cc.name AS "classCourse", s.name AS "subjectName", r.period_position AS period
        FROM grading_rules r JOIN academic_years y ON y.id = r.academic_year_id LEFT JOIN courses co ON co.id = r.course_id LEFT JOIN school_classes c ON c.id = r.class_id LEFT JOIN courses cc ON cc.id = c.course_id
             LEFT JOIN subjects s ON s.id = r.subject_id
       WHERE r.model_id = ${id}::uuid AND y.status <> 'CLOSED' ORDER BY y.starts_on DESC, c.grade NULLS FIRST, s.name NULLS FIRST, r.period_position NULLS FIRST LIMIT 60`;
  }

  async createModel(m: { id: string; name: string; description: string | null; definition: Definition; from: string }, actorId: string | null, now: Date): Promise<"ok" | "taken"> {
    try {
      await this.tx(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO grading_models (id, name, description, draft, created_by_id, created_at, updated_by_id, updated_at)
          VALUES (${m.id}::uuid, ${m.name}, ${m.description}, ${json(m.definition)}::jsonb, ${actorId}::uuid, ${now}, ${actorId}::uuid, ${now})`;
        await this.record(tx, "GRADING_MODEL_CREATED", m.id, actorId, { name: m.name, from: m.from }, now);
      });
      return "ok";
    } catch (e) {
      if (isUnique(e)) return "taken";
      throw e;
    }
  }
  /** Grava o rascunho se ninguém gravou entretanto (revision). */
  async saveDraft(id: string, revision: number, m: { name: string; description: string | null; draft: Definition | null }, actorId: string | null, now: Date): Promise<"ok" | "taken" | "changed"> {
    try {
      const n = await this.db.$executeRaw`
        UPDATE grading_models SET name = ${m.name}, description = ${m.description}, draft = ${m.draft ? json(m.draft) : null}::jsonb, revision = revision + 1, updated_by_id = ${actorId}::uuid, updated_at = ${now}
         WHERE id = ${id}::uuid AND revision = ${revision} AND archived_at IS NULL`;
      return n === 1 ? "ok" : "changed";
    } catch (e) {
      if (isUnique(e)) return "taken";
      throw e;
    }
  }
  /** O rascunho passa a versão em vigor (imutável), na mesma transação do histórico. */
  async publish(id: string, revision: number, number: number, d: Definition, reason: string | null, changes: string[], actorId: string | null, now: Date) {
    return this.tx(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE grading_models SET draft = NULL, current_version = ${number}, revision = revision + 1, updated_by_id = ${actorId}::uuid, updated_at = ${now}
         WHERE id = ${id}::uuid AND revision = ${revision} AND archived_at IS NULL AND coalesce(current_version, 0) = ${number - 1}`;
      if (n !== 1) return false;
      await tx.$executeRaw`
        INSERT INTO grading_model_versions (id, model_id, number, definition, reason, published_by_id, published_at)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, ${number}, ${json(d)}::jsonb, ${reason}, ${actorId}::uuid, ${now})`;
      await this.record(tx, "GRADING_MODEL_PUBLISHED", id, actorId, { version: number, reason, changes }, now);
      return true;
    });
  }
  /** Apaga um modelo que nunca foi publicado nem usado. */
  async deleteModel(id: string) {
    try {
      return (await this.db.$executeRaw`DELETE FROM grading_models WHERE id = ${id}::uuid AND current_version IS NULL`) === 1;
    } catch (e) {
      if (isForeignKey(e)) return false;
      throw e;
    }
  }
  async setArchived(id: string, archived: boolean, actorId: string | null, now: Date) {
    return this.tx(async (tx) => {
      const n = archived
        ? await tx.$executeRaw`
            UPDATE grading_models m SET archived_at = ${now}, revision = revision + 1 WHERE id = ${id}::uuid AND archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM grading_rules r JOIN academic_years y ON y.id = r.academic_year_id WHERE r.model_id = m.id AND y.status <> 'CLOSED')`
        : await tx.$executeRaw`UPDATE grading_models SET archived_at = NULL, revision = revision + 1 WHERE id = ${id}::uuid AND archived_at IS NOT NULL`;
      if (n !== 1) return false;
      await this.record(tx, archived ? "GRADING_MODEL_ARCHIVED" : "GRADING_MODEL_RESTORED", id, actorId, {}, now);
      return true;
    });
  }

  // ================================================================ elementos de avaliação

  types(): Promise<TypeRow[]> {
    return this.db.$queryRaw<TypeRow[]>`
      SELECT t.id, t.name, t.archived_at IS NOT NULL AS archived,
             (SELECT count(*)::int FROM grading_models m LEFT JOIN grading_model_versions v ON v.model_id = m.id AND v.number = m.current_version
               WHERE m.archived_at IS NULL AND (m.draft::text LIKE '%' || t.id::text || '%' OR v.definition::text LIKE '%' || t.id::text || '%')) AS used
        FROM grading_types t ORDER BY t.archived_at IS NOT NULL, t.position, lower(t.name)`;
  }
  async addTypes(names: string[], actorId: string | null, now: Date) {
    const rows = names.map((name, i) => ({ id: randomUUID(), name, p: i }));
    await this.tx(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO grading_types (id, name, position, created_at)
        SELECT x.id, x.name, (SELECT coalesce(max(position), 0) FROM grading_types) + x.p + 1, ${now} FROM json_to_recordset(${json(rows)}::json) AS x(id uuid, name text, p int)
        ON CONFLICT (lower(name)) DO UPDATE SET archived_at = NULL`;
      await this.record(tx, "GRADING_TYPES_ADDED", TYPES_SUBJECT, actorId, { names }, now);
    });
  }
  async renameType(id: string, name: string, actorId: string | null, now: Date): Promise<"ok" | "taken" | "missing"> {
    try {
      return await this.tx(async (tx) => {
        const [old] = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM grading_types WHERE id = ${id}::uuid FOR UPDATE`;
        if (!old) return "missing" as const;
        await tx.$executeRaw`UPDATE grading_types SET name = ${name} WHERE id = ${id}::uuid`;
        await this.record(tx, "GRADING_TYPE_RENAMED", TYPES_SUBJECT, actorId, { before: old.name, after: name }, now);
        return "ok" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "taken";
      throw e;
    }
  }
  /** Apaga o que nenhum modelo (nem versão antiga) usa; senão arquiva. */
  async removeType(id: string, actorId: string | null, now: Date): Promise<"removed" | "archived" | "missing"> {
    return this.tx(async (tx) => {
      const n = await tx.$executeRaw`
        DELETE FROM grading_types t WHERE t.id = ${id}::uuid
           AND NOT EXISTS (SELECT 1 FROM grading_models m WHERE m.draft::text LIKE '%' || t.id::text || '%')
           AND NOT EXISTS (SELECT 1 FROM grading_model_versions v WHERE v.definition::text LIKE '%' || t.id::text || '%')`;
      const result = n === 1 ? "removed" : (await tx.$executeRaw`UPDATE grading_types SET archived_at = ${now} WHERE id = ${id}::uuid AND archived_at IS NULL`) === 1 ? "archived" : "missing";
      if (result !== "missing") await this.record(tx, "GRADING_TYPE_REMOVED", TYPES_SUBJECT, actorId, { id, result }, now);
      return result;
    });
  }
  async restoreType(id: string) {
    return (await this.db.$executeRaw`UPDATE grading_types SET archived_at = NULL WHERE id = ${id}::uuid`) === 1;
  }

  // ================================================================ regras

  years(): Promise<YearRow[]> {
    return this.db.$queryRaw<YearRow[]>`
      SELECT id, name, status, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn", period_kind AS "periodKind" FROM academic_years ORDER BY starts_on DESC`;
  }
  classes(yearId: string): Promise<ClassRow[]> {
    return this.db.$queryRaw<ClassRow[]>`
      SELECT c.id, c.grade, c.course_id AS "courseId", co.name AS "courseName", (SELECT count(*)::int FROM class_groups g WHERE g.class_id = c.id) AS groups,
             (SELECT coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code, 'color', s.color) ORDER BY cs.position, s.name), '[]'::json) FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id WHERE cs.class_id = c.id) AS subjects
        FROM school_classes c LEFT JOIN courses co ON co.id = c.course_id WHERE c.academic_year_id = ${yearId}::uuid ORDER BY c.grade, co.name NULLS FIRST`;
  }
  rules(yearId: string): Promise<Rule[]> {
    return this.db.$queryRaw<Rule[]>`
      SELECT id, level, course_id AS "courseId", class_id AS "classId", subject_id AS "subjectId", period_position AS period, model_id AS "modelId" FROM grading_rules WHERE academic_year_id = ${yearId}::uuid`;
  }
  /** Grava (ou retira, modelId null) uma regra em cada sítio indicado. */
  async setRules(yearId: string, scopes: Scope[], modelId: string | null, actorId: string | null, now: Date, details: Record<string, unknown>) {
    for (const s of scopes) {
      const where = Prisma.sql`academic_year_id = ${yearId}::uuid AND level IS NOT DISTINCT FROM ${s.level} AND course_id IS NOT DISTINCT FROM ${s.courseId}::uuid AND class_id IS NOT DISTINCT FROM ${s.classId}::uuid AND subject_id IS NOT DISTINCT FROM ${s.subjectId}::uuid AND period_position IS NOT DISTINCT FROM ${s.period}::int`;
      if (!modelId) await this.db.$executeRaw`DELETE FROM grading_rules WHERE ${where}`;
      else if ((await this.db.$executeRaw`UPDATE grading_rules SET model_id = ${modelId}::uuid, set_by_id = ${actorId}::uuid, set_at = ${now} WHERE ${where}`) === 0)
        await this.db.$executeRaw`
          INSERT INTO grading_rules (id, academic_year_id, level, course_id, class_id, subject_id, period_position, model_id, set_by_id, set_at)
          VALUES (${randomUUID()}::uuid, ${yearId}::uuid, ${s.level}, ${s.courseId}::uuid, ${s.classId}::uuid, ${s.subjectId}::uuid, ${s.period}::int, ${modelId}::uuid, ${actorId}::uuid, ${now})`;
    }
    await this.record(this.db, "GRADING_RULES_SET", yearId, actorId, details, now);
  }
  async insertRules(yearId: string, rules: (Scope & { modelId: string })[], actorId: string | null, now: Date, details: Record<string, unknown>) {
    let n = 0;
    for (const r of rules)
      n += await this.db.$executeRaw`
        INSERT INTO grading_rules (id, academic_year_id, level, course_id, class_id, subject_id, period_position, model_id, set_by_id, set_at)
        VALUES (${randomUUID()}::uuid, ${yearId}::uuid, ${r.level}, ${r.courseId}::uuid, ${r.classId}::uuid, ${r.subjectId}::uuid, ${r.period}::int, ${r.modelId}::uuid, ${actorId}::uuid, ${now}) ON CONFLICT DO NOTHING`;
    await this.record(this.db, "GRADING_RULES_COPIED", yearId, actorId, { ...details, created: n }, now);
    return n;
  }

  // ================================================================ histórico

  history(subjectId: string, types: string[], limit = 50) {
    return this.db.$queryRaw<{ at: Date; type: string; by: string | null; details: Record<string, unknown> | null }[]>`
      SELECT a.occurred_at AS at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ${subjectId}::uuid AND a.type = ANY(${types}) ORDER BY a.occurred_at DESC LIMIT ${limit}`;
  }
  private async record(db: Db, type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
