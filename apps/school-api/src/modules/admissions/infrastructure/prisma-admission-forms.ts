import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { AdmissionFormsRepository, FieldRow, SectionRow, VersionRow } from "../application/forms-ports";
import type { DocumentTypeRow } from "../application/settings-ports";
import type { FieldCondition, FieldInput, FieldSettings, FieldType, FixedMode, FixedScope, FormSnapshot, SectionInput } from "../domain/forms";
import type { DocumentTarget, FileFormat, ProcessType } from "../domain/settings";

type SectionSel = Prisma.AdmissionFormSectionGetPayload<{ include: { fields: true } }>;
type FieldSel = SectionSel["fields"][number];

const toField = (f: FieldSel): FieldRow => ({
  id: f.id,
  sectionId: f.sectionId,
  label: f.label,
  type: f.type as FieldType,
  required: f.required,
  help: f.help,
  options: (f.options as string[]) ?? [],
  settings: (f.settings as FieldSettings) ?? {},
  processTypes: f.processTypes as ProcessType[],
  condition: (f.condition as unknown as FieldCondition | null) ?? null,
  position: f.position,
  active: f.active,
});

const toSection = (s: SectionSel): SectionRow => ({
  id: s.id,
  title: s.title,
  description: s.description,
  repeatable: s.repeatable,
  entryLabel: s.entryLabel,
  maxEntries: s.maxEntries,
  processTypes: s.processTypes as ProcessType[],
  position: s.position,
  active: s.active,
  fields: [...s.fields].sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()).map(toField),
});

const sectionColumns = (s: SectionInput) => ({ title: s.title, description: s.description, repeatable: s.repeatable, entryLabel: s.entryLabel, maxEntries: s.maxEntries, processTypes: s.processTypes });
const fieldColumns = (f: FieldInput) => ({
  label: f.label,
  type: f.type,
  required: f.required,
  help: f.help,
  options: f.options as Prisma.InputJsonValue,
  settings: f.settings as Prisma.InputJsonValue,
  processTypes: f.processTypes,
  condition: f.condition ? (f.condition as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
});

/** Formulários das inscrições na BD do PRÓPRIO colégio. */
export class PrismaAdmissionFormsRepository implements AdmissionFormsRepository {
  constructor(private readonly db: PrismaClient) {}

  async overrides() {
    return (await this.db.admissionFixedField.findMany()).map((o) => ({ scope: o.scope as FixedScope, key: o.key, mode: o.mode as FixedMode }));
  }

  async setOverride(scope: FixedScope, key: string, mode: FixedMode, now: Date) {
    await this.db.admissionFixedField.upsert({ where: { scope_key: { scope, key } }, create: { scope, key, mode, updatedAt: now }, update: { mode, updatedAt: now } });
  }

  async sections() {
    const rows = await this.db.admissionFormSection.findMany({ include: { fields: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
    return rows.map(toSection);
  }

  async createSection(id: string, input: SectionInput, now: Date) {
    const last = await this.db.admissionFormSection.aggregate({ _max: { position: true } });
    await this.db.admissionFormSection.create({ data: { id, ...sectionColumns(input), position: (last._max.position ?? 0) + 1, createdAt: now, updatedAt: now } });
  }

  async updateSection(id: string, input: SectionInput, now: Date) {
    return (await this.db.admissionFormSection.updateMany({ where: { id }, data: { ...sectionColumns(input), updatedAt: now } })).count > 0;
  }

  async setSectionActive(id: string, active: boolean, now: Date) {
    return (await this.db.admissionFormSection.updateMany({ where: { id }, data: { active, updatedAt: now } })).count > 0;
  }

  async deleteSection(id: string) {
    return (await this.db.admissionFormSection.deleteMany({ where: { id } })).count > 0;
  }

  async reorderSections(ids: string[]) {
    await this.db.$transaction(ids.map((id, i) => this.db.admissionFormSection.update({ where: { id }, data: { position: i + 1 } })));
  }

  async createField(id: string, sectionId: string, input: FieldInput, now: Date) {
    const last = await this.db.admissionFormField.aggregate({ where: { sectionId }, _max: { position: true } });
    await this.db.admissionFormField.create({ data: { id, sectionId, ...fieldColumns(input), position: (last._max.position ?? 0) + 1, createdAt: now, updatedAt: now } });
  }

  async updateField(id: string, input: FieldInput, now: Date) {
    return (await this.db.admissionFormField.updateMany({ where: { id }, data: { ...fieldColumns(input), updatedAt: now } })).count > 0;
  }

  async setFieldActive(id: string, active: boolean, now: Date) {
    return (await this.db.admissionFormField.updateMany({ where: { id }, data: { active, updatedAt: now } })).count > 0;
  }

  async deleteField(id: string) {
    return (await this.db.admissionFormField.deleteMany({ where: { id } })).count > 0;
  }

  async reorderFields(sectionId: string, ids: string[]) {
    await this.db.$transaction(ids.map((id, i) => this.db.admissionFormField.update({ where: { id, sectionId }, data: { position: i + 1 } })));
  }

  async activeDocuments(): Promise<DocumentTypeRow[]> {
    const rows = await this.db.admissionDocumentType.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      required: d.required,
      target: d.target as DocumentTarget,
      processTypes: d.processTypes as ProcessType[],
      formats: d.formats as FileFormat[],
      maxSizeMb: d.maxSizeMb,
      maxFiles: d.maxFiles,
      needsExpiry: d.needsExpiry,
      position: d.position,
      active: d.active,
      updatedAt: d.updatedAt,
    }));
  }

  private async withNames<T extends { publishedById: string | null }>(rows: T[]) {
    const ids = [...new Set(rows.map((r) => r.publishedById).filter((x): x is string => !!x))];
    const users = ids.length ? await this.db.schoolUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({ ...r, publishedBy: r.publishedById ? (name.get(r.publishedById) ?? null) : null }));
  }

  async latestVersion(): Promise<VersionRow | null> {
    const v = await this.db.admissionFormVersion.findFirst({ orderBy: { number: "desc" } });
    if (!v) return null;
    const [n] = await this.withNames([v]);
    return { number: n.number, publishedAt: n.publishedAt, publishedBy: n.publishedBy, snapshot: n.snapshot as unknown as FormSnapshot };
  }

  async versions() {
    const rows = await this.db.admissionFormVersion.findMany({ select: { number: true, publishedAt: true, publishedById: true }, orderBy: { number: "desc" } });
    return (await this.withNames(rows)).map((r) => ({ number: r.number, publishedAt: r.publishedAt, publishedBy: r.publishedBy }));
  }

  async version(number: number): Promise<VersionRow | null> {
    const v = await this.db.admissionFormVersion.findUnique({ where: { number } });
    if (!v) return null;
    const [n] = await this.withNames([v]);
    return { number: n.number, publishedAt: n.publishedAt, publishedBy: n.publishedBy, snapshot: n.snapshot as unknown as FormSnapshot };
  }

  publish(id: string, snapshot: FormSnapshot, actorId: string | null, now: Date) {
    return this.db.$transaction(async (tx) => {
      // um só a publicar de cada vez (o número é sequencial)
      await tx.$executeRaw`LOCK TABLE admission_form_versions IN EXCLUSIVE MODE`;
      const last = await tx.admissionFormVersion.aggregate({ _max: { number: true } });
      const number = (last._max.number ?? 0) + 1;
      await tx.admissionFormVersion.create({ data: { id, number, snapshot: snapshot as unknown as Prisma.InputJsonValue, publishedById: actorId, publishedAt: now } });
      return number;
    });
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
