import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";
import type { ContractEmployee, ContractFile, ContractRepository, ContractRow, ContractWrite } from "../application/contract-ports";
import { CONTRACTABLE, type ContractData, type ContractKind, type ContractRegime, contractsOverlap } from "../domain/contracts";

type Tx = Prisma.TransactionClient;
const EMPLOYEE = { id: true, fullName: true, number: true, status: true, jobTitle: true, department: true, employeeType: { select: { name: true } } } as const;
type EmployeeSel = { id: string; fullName: string; number: number | null; status: string; jobTitle: string | null; department: string | null; employeeType: { name: string } | null };

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (s: string | null) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const toEmployee = (e: EmployeeSel): ContractEmployee => ({ id: e.id, fullName: e.fullName, number: e.number, status: e.status, jobTitle: e.jobTitle, department: e.department, typeName: e.employeeType?.name ?? null });

type Row = Prisma.EmployeeContractGetPayload<object>;
function toRow(c: Row): ContractRow {
  const file: ContractFile | null =
    c.fileStorageKey && c.fileName ? { name: c.fileName, mimeType: c.fileMimeType ?? "application/octet-stream", size: c.fileSize ?? 0, uploadedAt: c.fileUploadedAt ?? c.updatedAt, storageKey: c.fileStorageKey } : null;
  return {
    id: c.id,
    number: c.number,
    employeeId: c.employeeId,
    kind: c.kind as ContractKind,
    regime: c.regime as ContractRegime,
    weeklyHours: c.weeklyHours,
    jobTitle: c.jobTitle,
    department: c.department,
    startsOn: day(c.startsOn)!,
    endsOn: day(c.endsOn),
    trialEndsOn: day(c.trialEndsOn),
    notes: c.notes,
    baseSalary: c.baseSalary,
    previousId: c.previousId,
    terminatedOn: day(c.terminatedOn),
    terminationReason: c.terminationReason,
    file,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

const dataColumns = (d: ContractData) => ({
  kind: d.kind,
  regime: d.regime,
  weeklyHours: d.weeklyHours,
  jobTitle: d.jobTitle,
  department: d.department,
  startsOn: asDate(d.startsOn)!,
  endsOn: asDate(d.endsOn),
  trialEndsOn: asDate(d.trialEndsOn),
  notes: d.notes,
});

/** Contratos na BD do PRÓPRIO colégio. */
export class PrismaContractRepository implements ContractRepository {
  constructor(private readonly db: PrismaClient) {}

  async employee(id: string) {
    const e = await this.db.employee.findUnique({ where: { id }, select: EMPLOYEE });
    return e ? toEmployee(e) : null;
  }

  async contractableEmployees() {
    const rows = await this.db.employee.findMany({ where: { status: { in: [...CONTRACTABLE] } }, select: EMPLOYEE, orderBy: { fullName: "asc" } });
    return rows.map(toEmployee);
  }

  async contractsOf(employeeId: string) {
    return (await this.db.employeeContract.findMany({ where: { employeeId }, orderBy: { startsOn: "desc" } })).map(toRow);
  }

  async find(id: string) {
    const c = await this.db.employeeContract.findUnique({ where: { id }, include: { employee: { select: EMPLOYEE } } });
    return c ? { ...toRow(c), employee: toEmployee(c.employee) } : null;
  }

  async all() {
    const rows = await this.db.employeeContract.findMany({ include: { employee: { select: EMPLOYEE } }, orderBy: { startsOn: "desc" } });
    return rows.map((c) => ({ ...toRow(c), employee: toEmployee(c.employee) }));
  }

  /** Outro contrato do funcionário que se sobreponha a estas datas (com o funcionário bloqueado). */
  private async clash(tx: Tx, employeeId: string, dates: { startsOn: string; endsOn: string | null; terminatedOn: string | null }, except: string | null) {
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE`;
    const others = (await tx.employeeContract.findMany({ where: { employeeId, ...(except ? { id: { not: except } } : {}) } })).map(toRow);
    return others.find((o) => contractsOverlap(o, dates)) ?? null;
  }

  create(input: { id: string; employeeId: string; data: ContractData; baseSalary: number | null; previousId: string | null; actorId: string | null; now: Date }): Promise<ContractWrite> {
    return this.db.$transaction(async (tx) => {
      const other = await this.clash(tx, input.employeeId, { startsOn: input.data.startsOn, endsOn: input.data.endsOn, terminatedOn: null }, null);
      if (other) return { ok: false, reason: "overlap", with: other.number } as const;
      const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('contract_number_seq') AS n`;
      const number = Number(n);
      await tx.employeeContract.create({
        data: {
          id: input.id,
          number,
          employeeId: input.employeeId,
          ...dataColumns(input.data),
          baseSalary: input.baseSalary,
          previousId: input.previousId,
          createdById: input.actorId,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
      return { ok: true, value: { id: input.id, number } } as const;
    });
  }

  update(id: string, input: { data: ContractData; baseSalary?: number | null; now: Date }): Promise<ContractWrite> {
    return this.db.$transaction(async (tx) => {
      const c = (await tx.employeeContract.findUnique({ where: { id } }))!;
      const other = await this.clash(tx, c.employeeId, { startsOn: input.data.startsOn, endsOn: input.data.endsOn, terminatedOn: day(c.terminatedOn) }, id);
      if (other) return { ok: false, reason: "overlap", with: other.number } as const;
      await tx.employeeContract.update({
        where: { id },
        data: { ...dataColumns(input.data), ...(input.baseSalary !== undefined ? { baseSalary: input.baseSalary } : {}), updatedAt: input.now },
      });
      return { ok: true, value: { id, number: c.number } } as const;
    });
  }

  async terminate(id: string, input: { terminatedOn: string; reason: string; now: Date }) {
    await this.db.employeeContract.update({ where: { id }, data: { terminatedOn: asDate(input.terminatedOn), terminationReason: input.reason, updatedAt: input.now } });
  }

  async remove(id: string) {
    await this.db.employeeContract.delete({ where: { id } });
  }

  async setFile(id: string, file: ContractFile | null, sha256: string | null, now: Date) {
    const before = await this.db.employeeContract.findUnique({ where: { id }, select: { fileStorageKey: true } });
    await this.db.employeeContract.update({
      where: { id },
      data: file
        ? { fileName: file.name, fileMimeType: file.mimeType, fileSize: file.size, fileSha256: sha256, fileStorageKey: file.storageKey, fileUploadedAt: file.uploadedAt, updatedAt: now }
        : { fileName: null, fileMimeType: null, fileSize: null, fileSha256: null, fileStorageKey: null, fileUploadedAt: null, updatedAt: now },
    });
    return before?.fileStorageKey ?? null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
