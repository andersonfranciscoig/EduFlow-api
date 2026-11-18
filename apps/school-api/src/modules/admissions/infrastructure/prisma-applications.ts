import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { ApplicationStatus, Entry, Shift, StepKey } from "../domain/applications";
import { formatApplicationNumber } from "../domain/applications";
import type { ProcessType } from "../domain/settings";
import type { ApplicationFileRow, ApplicationRow, ApplicationsRepository, OpenYear, SubmitInput, SubmitOutcome } from "../application/applications-ports";

type AppSel = Prisma.ApplicationGetPayload<object>;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => (v && typeof v === "object" ? (v as Entry) : {});

const toRow = (a: AppSel): ApplicationRow => ({
  id: a.id,
  number: a.number,
  accountId: a.accountId,
  studentId: a.studentId,
  processType: a.processType as ProcessType,
  formVersion: a.formVersion,
  academicYearId: a.academicYearId,
  classId: a.classId,
  shift: a.shift as Shift | null,
  studentData: json(a.studentData),
  guardianData: json(a.guardianData),
  sectionsData: json(a.sectionsData) as unknown as Record<string, Entry[]>,
  status: a.status as ApplicationStatus,
  currentStep: a.currentStep as StepKey,
  version: a.version,
  termsAcceptedAt: a.termsAcceptedAt,
  legitimacyDeclared: a.legitimacyDeclared,
  submittedAt: a.submittedAt,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/** Estados em que a inscrição de um aluno ainda "ocupa" o ano (não se faz outra igual). */
const ACTIVE: ApplicationStatus[] = ["SUBMITTED", "UNDER_REVIEW", "CORRECTION_REQUIRED", "APPROVED"];

class Duplicate extends Error {
  constructor(readonly number: string) {
    super("duplicate");
  }
}
class Stale extends Error {}

/** Inscrições na BD do PRÓPRIO colégio. */
export class PrismaApplicationsRepository implements ApplicationsRepository {
  constructor(private readonly db: PrismaClient) {}

  async byAccount(accountId: string) {
    const rows = await this.db.application.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      include: { academicYear: { select: { name: true } }, schoolClass: { select: { grade: true, course: { select: { name: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      processType: r.processType as ProcessType,
      status: r.status as ApplicationStatus,
      currentStep: r.currentStep as StepKey,
      studentName: typeof json(r.studentData).fullName === "string" ? (json(r.studentData).fullName as string) : null,
      yearName: r.academicYear?.name ?? null,
      grade: r.schoolClass?.grade ?? null,
      courseName: r.schoolClass?.course?.name ?? null,
      submittedAt: r.submittedAt,
      updatedAt: r.updatedAt,
    }));
  }

  async byId(id: string) {
    const a = await this.db.application.findUnique({ where: { id } });
    return a ? toRow(a) : null;
  }

  async create(row: Parameters<ApplicationsRepository["create"]>[0]) {
    await this.db.application.create({
      data: {
        id: row.id,
        accountId: row.accountId,
        processType: row.processType,
        formVersion: row.formVersion,
        studentData: row.studentData as Prisma.InputJsonValue,
        guardianData: row.guardianData as Prisma.InputJsonValue,
        sectionsData: row.sectionsData as unknown as Prisma.InputJsonValue,
        status: row.status,
        currentStep: row.currentStep,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      },
    });
  }

  async save(id: string, expectedVersion: number, set: Parameters<ApplicationsRepository["save"]>[2], now: Date) {
    const data: Prisma.ApplicationUncheckedUpdateManyInput = { version: { increment: 1 }, updatedAt: now };
    if ("academicYearId" in set) data.academicYearId = set.academicYearId;
    if ("classId" in set) data.classId = set.classId;
    if ("shift" in set) data.shift = set.shift;
    if (set.studentData) data.studentData = set.studentData as Prisma.InputJsonValue;
    if (set.guardianData) data.guardianData = set.guardianData as Prisma.InputJsonValue;
    if (set.sectionsData) data.sectionsData = set.sectionsData as unknown as Prisma.InputJsonValue;
    if (set.currentStep) data.currentStep = set.currentStep;
    const r = await this.db.application.updateMany({ where: { id, version: expectedVersion, status: "DRAFT" }, data });
    return r.count === 1 ? expectedVersion + 1 : null;
  }

  async remove(id: string) {
    await this.db.application.delete({ where: { id } });
  }

  async files(applicationId: string): Promise<ApplicationFileRow[]> {
    const rows = await this.db.applicationFile.findMany({ where: { applicationId }, orderBy: { createdAt: "asc" } });
    return rows.map((f) => ({ ...f, slot: f.slot as ApplicationFileRow["slot"] }));
  }

  async addFile(row: ApplicationFileRow) {
    await this.db.applicationFile.create({ data: row });
  }

  async removeFile(id: string) {
    await this.db.applicationFile.deleteMany({ where: { id } });
  }

  async openYears(today: string): Promise<OpenYear[]> {
    const day = new Date(`${today}T00:00:00Z`);
    const years = await this.db.academicYear.findMany({
      where: { status: { not: "CLOSED" }, admissionPeriods: { applicationsFrom: { lte: day }, applicationsTo: { gte: day } } },
      orderBy: { startsOn: "asc" },
      include: {
        admissionPeriods: true,
        classes: { orderBy: [{ grade: "asc" }, { createdAt: "asc" }], include: { course: { select: { name: true } }, groups: { select: { shift: true } } } },
      },
    });
    const order: Shift[] = ["MANHA", "TARDE", "NOITE"];
    return years.map((y) => ({
      id: y.id,
      name: y.name,
      from: iso(y.admissionPeriods!.applicationsFrom!),
      to: iso(y.admissionPeriods!.applicationsTo!),
      classes: y.classes.map((c) => ({
        id: c.id,
        grade: c.grade,
        courseName: c.course?.name ?? null,
        description: c.description,
        shifts: order.filter((s) => c.groups.some((g) => g.shift === s)),
      })),
    }));
  }

  async yearName(id: string) {
    return (await this.db.academicYear.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
  }

  async classLabel(id: string) {
    const c = await this.db.schoolClass.findUnique({ where: { id }, select: { grade: true, course: { select: { name: true } } } });
    return c ? { grade: c.grade, courseName: c.course?.name ?? null } : null;
  }

  /**
   * Numa só transação: o aluno (o mesmo, se já existir para esta conta/encarregado), o encarregado
   * e a relação, o n.º do processo, o estado e o histórico. A versão protege de duas submissões.
   */
  async submit(input: SubmitInput): Promise<SubmitOutcome> {
    try {
      return await this.db.$transaction(async (tx) => {
        const app = await tx.application.findUnique({ where: { id: input.applicationId } });
        if (!app || app.version !== input.expectedVersion || app.status !== "DRAFT") throw new Stale();
        const now = input.now;
        const birth = new Date(`${input.student.birthDate}T00:00:00Z`);
        const studentFields = { fullName: input.student.fullName, birthDate: birth, gender: input.student.gender, data: input.student.data as Prisma.InputJsonValue, updatedAt: now };

        // ---- o encarregado (a conta GUARDIAN é sempre o encarregado; o aluno maior pode indicar um)
        let guardianId: string | null = null;
        if (input.guardian) {
          const gFields = { fullName: input.guardian.fullName, email: input.guardian.email, phone: input.guardian.phone, data: input.guardian.data as Prisma.InputJsonValue, updatedAt: now };
          if (input.accountKind === "GUARDIAN") {
            const existing = await tx.guardian.findUnique({ where: { accountId: input.accountId } });
            guardianId = existing?.id ?? randomUUID();
            if (existing) await tx.guardian.update({ where: { id: existing.id }, data: gFields });
            else await tx.guardian.create({ data: { id: guardianId, accountId: input.accountId, ...gFields, createdAt: now } });
          } else {
            guardianId = randomUUID();
            await tx.guardian.create({ data: { id: guardianId, ...gFields, createdAt: now } });
          }
        }

        // ---- o aluno: o titular da conta (aluno maior) ou um educando já conhecido do encarregado
        let studentId: string | null = null;
        if (input.accountKind === "STUDENT") {
          studentId = (await tx.student.findUnique({ where: { accountId: input.accountId }, select: { id: true } }))?.id ?? null;
        } else if (guardianId) {
          const known = await tx.student.findFirst({
            where: { birthDate: birth, fullName: { equals: input.student.fullName, mode: "insensitive" }, guardians: { some: { guardianId } } },
            select: { id: true },
          });
          studentId = known?.id ?? null;
        }
        if (studentId) {
          const dup = await tx.application.findFirst({ where: { studentId, academicYearId: app.academicYearId, status: { in: ACTIVE }, id: { not: app.id } }, select: { number: true } });
          if (dup?.number) throw new Duplicate(dup.number);
          await tx.student.update({ where: { id: studentId }, data: studentFields });
        } else {
          studentId = randomUUID();
          await tx.student.create({ data: { id: studentId, ...studentFields, accountId: input.accountKind === "STUDENT" ? input.accountId : null, status: "CANDIDATE", createdAt: now } });
        }

        if (guardianId) {
          const hasPrimary = await tx.studentGuardian.findFirst({ where: { studentId, isPrimary: true, guardianId: { not: guardianId } }, select: { guardianId: true } });
          const link = {
            relationship: input.guardian!.relationship,
            relationshipOther: input.guardian!.relationship === "Outro" ? input.guardian!.relationshipOther : null,
            isEmergency: true,
            // só o encarregado (conta GUARDIAN) gere o educando menor; o aluno maior gere-se a si próprio
            canManage: input.accountKind === "GUARDIAN",
            isFinancial: input.accountKind === "GUARDIAN",
            updatedAt: now,
          };
          await tx.studentGuardian.upsert({
            where: { studentId_guardianId: { studentId, guardianId } },
            update: link,
            create: { studentId, guardianId, ...link, isPrimary: !hasPrimary, createdAt: now },
          });
        }

        const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`SELECT nextval('application_number_seq') AS seq`;
        const number = formatApplicationNumber(input.year, Number(seq));
        const done = await tx.application.updateMany({
          where: { id: app.id, version: input.expectedVersion, status: "DRAFT" },
          data: {
            status: "SUBMITTED",
            number,
            studentId,
            submittedAt: now,
            termsAcceptedAt: input.termsAcceptedAt,
            legitimacyDeclared: input.legitimacyDeclared,
            currentStep: "revisao",
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        if (done.count !== 1) throw new Stale();
        await tx.applicationHistory.create({
          data: { id: randomUUID(), applicationId: app.id, fromStatus: "DRAFT", toStatus: "SUBMITTED", actorKind: "FAMILY", actorId: input.accountId, actorName: input.actorName, createdAt: now },
        });
        return { ok: true as const, number, studentId };
      });
    } catch (e) {
      if (e instanceof Stale) return { ok: false, reason: "STALE" };
      if (e instanceof Duplicate) return { ok: false, reason: "DUPLICATE", number: e.number };
      throw e;
    }
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
