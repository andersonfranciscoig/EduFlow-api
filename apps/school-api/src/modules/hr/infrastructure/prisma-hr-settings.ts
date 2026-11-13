import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { ConfigOutcome, DocumentRow, EmployeeTypeRow, FieldRow, HrSettingsRepository, SectionRow, VersionInfo } from "../application/ports";
import {
  type DocumentTypeInput,
  type EmployeeTypeInput,
  type FieldInput,
  type FieldSettings,
  type FieldType,
  type FileFormat,
  type FormSnapshot,
  MAX_DOCUMENT_TYPES,
  MAX_EMPLOYEE_TYPES,
  MAX_FIELDS_PER_SECTION,
  type SectionInput,
  type SectionKey,
} from "../domain/form";

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const notFound = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
/** Bloqueio consultivo da publicação de versões (uma de cada vez). */
const PUBLISH_LOCK = 7_300_101;

const toSection = (s: { key: string; title: string; description: string | null; repeatable: boolean; entryLabel: string; maxEntries: number; position: number }): SectionRow => ({
  key: s.key as SectionKey,
  title: s.title,
  description: s.description,
  repeatable: s.repeatable,
  entryLabel: s.entryLabel,
  maxEntries: s.maxEntries,
  position: s.position,
});

const toField = (f: Prisma.HrFormFieldGetPayload<object>): FieldRow => ({
  id: f.id,
  sectionKey: f.sectionKey as SectionKey,
  label: f.label,
  type: f.type as FieldType,
  required: f.required,
  help: f.help,
  options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === "string") : [],
  settings: (f.settings && typeof f.settings === "object" && !Array.isArray(f.settings) ? f.settings : {}) as FieldSettings,
  position: f.position,
  active: f.active,
  employeeTypeIds: f.employeeTypeIds,
});

const toDocument = (d: Prisma.HrDocumentTypeGetPayload<object>): DocumentRow => ({
  id: d.id,
  name: d.name,
  description: d.description,
  required: d.required,
  formats: d.formats as FileFormat[],
  maxSizeMb: d.maxSizeMb,
  multiple: d.multiple,
  position: d.position,
  active: d.active,
  employeeTypeIds: d.employeeTypeIds,
});

const toType = (t: Prisma.HrEmployeeTypeGetPayload<object>): EmployeeTypeRow => ({ id: t.id, name: t.name, description: t.description, position: t.position, active: t.active });

const fieldData = (input: FieldInput) => ({
  label: input.label,
  type: input.type,
  required: input.required,
  help: input.help,
  options: input.options as Prisma.InputJsonValue,
  settings: input.settings as Prisma.InputJsonValue,
  employeeTypeIds: input.employeeTypeIds,
});

export class PrismaHrSettingsRepository implements HrSettingsRepository {
  constructor(private readonly db: PrismaClient) {}

  // ================================================================ tipos de funcionário

  async employeeTypes() {
    return (await this.db.hrEmployeeType.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] })).map(toType);
  }

  async createEmployeeType(input: EmployeeTypeInput & { id: string; now: Date }): Promise<ConfigOutcome<EmployeeTypeRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const agg = await tx.hrEmployeeType.aggregate({ _count: { _all: true }, _max: { position: true } });
        if (agg._count._all >= MAX_EMPLOYEE_TYPES) return { ok: false, reason: "limit" } as const;
        const row = await tx.hrEmployeeType.create({
          data: { id: input.id, name: input.name, description: input.description, position: (agg._max.position ?? 0) + 1, createdAt: input.now, updatedAt: input.now },
        });
        return { ok: true, value: toType(row) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      throw e;
    }
  }

  async updateEmployeeType(id: string, input: EmployeeTypeInput, now: Date): Promise<ConfigOutcome<EmployeeTypeRow>> {
    try {
      return { ok: true, value: toType(await this.db.hrEmployeeType.update({ where: { id }, data: { ...input, updatedAt: now } })) };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async setEmployeeTypeActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<EmployeeTypeRow>> {
    try {
      return { ok: true, value: toType(await this.db.hrEmployeeType.update({ where: { id }, data: { active, updatedAt: now } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async deleteEmployeeType(id: string): Promise<ConfigOutcome<EmployeeTypeRow>> {
    return this.db.$transaction(async (tx) => {
      const row = await tx.hrEmployeeType.findUnique({ where: { id } });
      if (!row) return { ok: false, reason: "not_found" } as const;
      const [fields, docs] = await Promise.all([tx.hrFormField.count({ where: { employeeTypeIds: { has: id } } }), tx.hrDocumentType.count({ where: { employeeTypeIds: { has: id } } })]);
      if (fields || docs) return { ok: false, reason: "in_use" } as const;
      await tx.hrEmployeeType.delete({ where: { id } });
      return { ok: true, value: toType(row) } as const;
    });
  }

  async reorderEmployeeTypes(ids: string[], now: Date): Promise<ConfigOutcome<void>> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.hrEmployeeType.findMany({ select: { id: true } });
      if (current.length !== ids.length || current.some((t) => !ids.includes(t.id))) return { ok: false, reason: "not_found" } as const;
      for (const [i, id] of ids.entries()) await tx.hrEmployeeType.update({ where: { id }, data: { position: i + 1, updatedAt: now } });
      return { ok: true, value: undefined } as const;
    });
  }

  async employeeTypeUsage() {
    const [fields, docs] = await Promise.all([
      this.db.hrFormField.findMany({ where: { employeeTypeIds: { isEmpty: false } }, select: { employeeTypeIds: true } }),
      this.db.hrDocumentType.findMany({ where: { employeeTypeIds: { isEmpty: false } }, select: { employeeTypeIds: true } }),
    ]);
    const usage: Record<string, number> = {};
    for (const r of [...fields, ...docs]) for (const id of r.employeeTypeIds) usage[id] = (usage[id] ?? 0) + 1;
    return usage;
  }

  async sections() {
    return (await this.db.hrFormSection.findMany({ orderBy: { position: "asc" } })).map(toSection);
  }

  async fields() {
    return (await this.db.hrFormField.findMany({ orderBy: [{ sectionKey: "asc" }, { position: "asc" }, { createdAt: "asc" }] })).map(toField);
  }

  async documents() {
    return (await this.db.hrDocumentType.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] })).map(toDocument);
  }

  private async withAuthors(rows: { id: string; number: number; publishedAt: Date; publishedById: string | null }[]): Promise<VersionInfo[]> {
    const ids = [...new Set(rows.map((r) => r.publishedById).filter((x): x is string => !!x))];
    const users = ids.length ? await this.db.schoolUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({ id: r.id, number: r.number, publishedAt: r.publishedAt, publishedBy: r.publishedById ? (names.get(r.publishedById) ?? null) : null }));
  }

  async versions() {
    const rows = await this.db.hrFormVersion.findMany({ orderBy: { number: "desc" }, take: 20, select: { id: true, number: true, publishedAt: true, publishedById: true } });
    return this.withAuthors(rows);
  }

  async latest() {
    const row = await this.db.hrFormVersion.findFirst({ orderBy: { number: "desc" } });
    if (!row) return null;
    const [info] = await this.withAuthors([row]);
    return { ...info, snapshot: row.snapshot as unknown as FormSnapshot };
  }

  async version(number: number) {
    const row = await this.db.hrFormVersion.findUnique({ where: { number } });
    if (!row) return null;
    const [info] = await this.withAuthors([row]);
    return { ...info, snapshot: row.snapshot as unknown as FormSnapshot };
  }

  async updateSection(key: SectionKey, input: SectionInput, now: Date): Promise<ConfigOutcome<SectionRow>> {
    try {
      return { ok: true, value: toSection(await this.db.hrFormSection.update({ where: { key }, data: { ...input, updatedAt: now } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async createField(input: FieldInput & { id: string; section: SectionKey; now: Date }): Promise<ConfigOutcome<FieldRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const agg = await tx.hrFormField.aggregate({ where: { sectionKey: input.section }, _count: { _all: true }, _max: { position: true } });
        if (agg._count._all >= MAX_FIELDS_PER_SECTION) return { ok: false, reason: "limit" } as const;
        const row = await tx.hrFormField.create({
          data: { id: input.id, sectionKey: input.section, ...fieldData(input), position: (agg._max.position ?? 0) + 1, createdAt: input.now, updatedAt: input.now },
        });
        return { ok: true, value: toField(row) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      throw e;
    }
  }

  async updateField(id: string, input: FieldInput, now: Date): Promise<ConfigOutcome<FieldRow>> {
    try {
      return { ok: true, value: toField(await this.db.hrFormField.update({ where: { id }, data: { ...fieldData(input), updatedAt: now } })) };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async setFieldActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<FieldRow>> {
    try {
      return { ok: true, value: toField(await this.db.hrFormField.update({ where: { id }, data: { active, updatedAt: now } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  /** As versões publicadas guardam a sua própria cópia: apagar daqui não mexe em cadastros já começados. */
  async deleteField(id: string): Promise<ConfigOutcome<FieldRow>> {
    try {
      return { ok: true, value: toField(await this.db.hrFormField.delete({ where: { id } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async reorderFields(section: SectionKey, ids: string[], now: Date): Promise<ConfigOutcome<void>> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.hrFormField.findMany({ where: { sectionKey: section }, select: { id: true } });
      if (current.length !== ids.length || current.some((f) => !ids.includes(f.id))) return { ok: false, reason: "not_found" } as const;
      for (const [i, id] of ids.entries()) await tx.hrFormField.update({ where: { id }, data: { position: i + 1, updatedAt: now } });
      return { ok: true, value: undefined } as const;
    });
  }

  async createDocument(input: DocumentTypeInput & { id: string; now: Date }): Promise<ConfigOutcome<DocumentRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const agg = await tx.hrDocumentType.aggregate({ _count: { _all: true }, _max: { position: true } });
        if (agg._count._all >= MAX_DOCUMENT_TYPES) return { ok: false, reason: "limit" } as const;
        const { id, now, ...data } = input;
        const row = await tx.hrDocumentType.create({ data: { id, ...data, position: (agg._max.position ?? 0) + 1, createdAt: now, updatedAt: now } });
        return { ok: true, value: toDocument(row) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      throw e;
    }
  }

  async updateDocument(id: string, input: DocumentTypeInput, now: Date): Promise<ConfigOutcome<DocumentRow>> {
    try {
      return { ok: true, value: toDocument(await this.db.hrDocumentType.update({ where: { id }, data: { ...input, updatedAt: now } })) };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "exists" };
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async setDocumentActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<DocumentRow>> {
    try {
      return { ok: true, value: toDocument(await this.db.hrDocumentType.update({ where: { id }, data: { active, updatedAt: now } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async deleteDocument(id: string): Promise<ConfigOutcome<DocumentRow>> {
    try {
      return { ok: true, value: toDocument(await this.db.hrDocumentType.delete({ where: { id } })) };
    } catch (e) {
      if (notFound(e)) return { ok: false, reason: "not_found" };
      throw e;
    }
  }

  async reorderDocuments(ids: string[], now: Date): Promise<ConfigOutcome<void>> {
    return this.db.$transaction(async (tx) => {
      const current = await tx.hrDocumentType.findMany({ select: { id: true } });
      if (current.length !== ids.length || current.some((d) => !ids.includes(d.id))) return { ok: false, reason: "not_found" } as const;
      for (const [i, id] of ids.entries()) await tx.hrDocumentType.update({ where: { id }, data: { position: i + 1, updatedAt: now } });
      return { ok: true, value: undefined } as const;
    });
  }

  async publish(snapshot: FormSnapshot, actorId: string | null, now: Date): Promise<VersionInfo> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_LOCK})`;
      const last = await tx.hrFormVersion.aggregate({ _max: { number: true } });
      return tx.hrFormVersion.create({
        data: { id: randomUUID(), number: (last._max.number ?? 0) + 1, snapshot: snapshot as unknown as Prisma.InputJsonValue, publishedById: actorId, publishedAt: now },
      });
    });
    const [info] = await this.withAuthors([row]);
    return info;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
