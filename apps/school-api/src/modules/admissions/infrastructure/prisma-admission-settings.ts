import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";
import type { AdmissionSettingsRepository, DocumentTypeRow, YearRow } from "../application/settings-ports";
import type { DocumentTarget, DocumentTypeInput, FileFormat, Periods, ProcessType } from "../domain/settings";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const win = (from: Date | null, to: Date | null) => (from && to ? { from: day(from)!, to: day(to)! } : null);

type YearSel = Prisma.AcademicYearGetPayload<{ include: { admissionPeriods: true } }>;
const toYear = (y: YearSel): YearRow => ({
  id: y.id,
  name: y.name,
  startsOn: day(y.startsOn)!,
  endsOn: day(y.endsOn)!,
  status: y.status as YearRow["status"],
  periods: {
    applications: win(y.admissionPeriods?.applicationsFrom ?? null, y.admissionPeriods?.applicationsTo ?? null),
    enrollments: win(y.admissionPeriods?.enrollmentsFrom ?? null, y.admissionPeriods?.enrollmentsTo ?? null),
    renewals: win(y.admissionPeriods?.renewalsFrom ?? null, y.admissionPeriods?.renewalsTo ?? null),
  },
  periodsUpdatedAt: y.admissionPeriods?.updatedAt ?? null,
});

type DocRow = Prisma.AdmissionDocumentTypeGetPayload<object>;
const toDocument = (d: DocRow): DocumentTypeRow => ({
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
});

const docColumns = (d: DocumentTypeInput) => ({
  name: d.name,
  description: d.description,
  required: d.required,
  target: d.target,
  processTypes: d.processTypes,
  formats: d.formats,
  maxSizeMb: d.maxSizeMb,
  maxFiles: d.maxFiles,
  needsExpiry: d.needsExpiry,
});

/** Configuração das inscrições na BD do PRÓPRIO colégio. */
export class PrismaAdmissionSettingsRepository implements AdmissionSettingsRepository {
  constructor(private readonly db: PrismaClient) {}

  async years() {
    const rows = await this.db.academicYear.findMany({ include: { admissionPeriods: true }, orderBy: { startsOn: "desc" } });
    return rows.map(toYear);
  }

  async year(id: string) {
    const y = await this.db.academicYear.findUnique({ where: { id }, include: { admissionPeriods: true } });
    return y ? toYear(y) : null;
  }

  async savePeriods(yearId: string, p: Periods, actorId: string | null, now: Date) {
    const data = {
      applicationsFrom: asDate(p.applications?.from),
      applicationsTo: asDate(p.applications?.to),
      enrollmentsFrom: asDate(p.enrollments?.from),
      enrollmentsTo: asDate(p.enrollments?.to),
      renewalsFrom: asDate(p.renewals?.from),
      renewalsTo: asDate(p.renewals?.to),
      updatedById: actorId,
      updatedAt: now,
    };
    await this.db.admissionPeriods.upsert({ where: { academicYearId: yearId }, create: { academicYearId: yearId, ...data }, update: data });
  }

  async documents() {
    return (await this.db.admissionDocumentType.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] })).map(toDocument);
  }

  async createDocument(input: DocumentTypeInput & { id: string; now: Date }) {
    const last = await this.db.admissionDocumentType.aggregate({ _max: { position: true } });
    await this.db.admissionDocumentType.create({ data: { id: input.id, ...docColumns(input), position: (last._max.position ?? 0) + 1, createdAt: input.now, updatedAt: input.now } });
  }

  async updateDocument(id: string, input: DocumentTypeInput, now: Date) {
    return (await this.db.admissionDocumentType.updateMany({ where: { id }, data: { ...docColumns(input), updatedAt: now } })).count > 0;
  }

  async setDocumentActive(id: string, active: boolean, now: Date) {
    return (await this.db.admissionDocumentType.updateMany({ where: { id }, data: { active, updatedAt: now } })).count > 0;
  }

  async deleteDocument(id: string) {
    return (await this.db.admissionDocumentType.deleteMany({ where: { id } })).count > 0;
  }

  async reorderDocuments(ids: string[]) {
    await this.db.$transaction(ids.map((id, i) => this.db.admissionDocumentType.update({ where: { id }, data: { position: i + 1 } })));
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
