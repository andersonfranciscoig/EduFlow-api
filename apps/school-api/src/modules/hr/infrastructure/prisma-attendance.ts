import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";
import type { AttendanceProof, AttendanceRepository, AttendanceRow } from "../application/attendance-ports";
import type { ContractEmployee } from "../application/contract-ports";
import { ATTENDANCE_EMPLOYEES, type AttendanceEntry, type AttendanceStatus } from "../domain/attendance";

const EMPLOYEE = { id: true, fullName: true, number: true, status: true, jobTitle: true, department: true, employeeType: { select: { name: true } } } as const;
type EmployeeSel = { id: string; fullName: string; number: number | null; status: string; jobTitle: string | null; department: string | null; employeeType: { name: string } | null };
const toEmployee = (e: EmployeeSel): ContractEmployee => ({ id: e.id, fullName: e.fullName, number: e.number, status: e.status, jobTitle: e.jobTitle, department: e.department, typeName: e.employeeType?.name ?? null });
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

type Row = Prisma.EmployeeAttendanceGetPayload<object>;
const toRow = (r: Row): AttendanceRow => ({
  id: r.id,
  employeeId: r.employeeId,
  day: r.day.toISOString().slice(0, 10),
  status: r.status as AttendanceStatus,
  minutesLate: r.minutesLate,
  note: r.note,
  proof: r.proofStorageKey && r.proofName ? { name: r.proofName, mimeType: r.proofMimeType ?? "application/octet-stream", size: r.proofSize ?? 0, uploadedAt: r.proofUploadedAt ?? r.updatedAt, storageKey: r.proofStorageKey } : null,
  updatedAt: r.updatedAt,
});

const NO_PROOF = { proofName: null, proofMimeType: null, proofSize: null, proofSha256: null, proofStorageKey: null, proofUploadedAt: null };

/** Assiduidade na BD do PRÓPRIO colégio. */
export class PrismaAttendanceRepository implements AttendanceRepository {
  constructor(private readonly db: PrismaClient) {}

  async employeesFor(from: string, to: string) {
    const rows = await this.db.employee.findMany({
      where: { OR: [{ status: { in: [...ATTENDANCE_EMPLOYEES] } }, { attendance: { some: { day: { gte: asDate(from), lte: asDate(to) } } } }] },
      select: EMPLOYEE,
      orderBy: { fullName: "asc" },
    });
    return rows.map(toEmployee);
  }

  async records(from: string, to: string) {
    return (await this.db.employeeAttendance.findMany({ where: { day: { gte: asDate(from), lte: asDate(to) } } })).map(toRow);
  }

  async find(id: string) {
    const r = await this.db.employeeAttendance.findUnique({ where: { id }, include: { employee: { select: EMPLOYEE } } });
    return r ? { ...toRow(r), employee: toEmployee(r.employee) } : null;
  }

  saveDay(day: string, entries: AttendanceEntry[], actorId: string | null, now: Date, newId: () => string) {
    return this.db.$transaction(async (tx) => {
      const date = asDate(day);
      const existing = await tx.employeeAttendance.findMany({ where: { day: date, employeeId: { in: entries.map((e) => e.employeeId) } } });
      const byEmployee = new Map(existing.map((r) => [r.employeeId, r]));
      const orphanProofs: string[] = [];
      let saved = 0;
      let cleared = 0;
      for (const e of entries) {
        const before = byEmployee.get(e.employeeId);
        if (e.status === null) {
          if (before) {
            await tx.employeeAttendance.delete({ where: { id: before.id } });
            if (before.proofStorageKey) orphanProofs.push(before.proofStorageKey);
            cleared++;
          }
          continue;
        }
        // uma presença não guarda comprovativo
        const dropProof = e.status === "PRESENTE" && !!before?.proofStorageKey;
        if (dropProof) orphanProofs.push(before!.proofStorageKey!);
        const data = { status: e.status, minutesLate: e.minutesLate, note: e.note, recordedById: actorId, updatedAt: now, ...(dropProof ? NO_PROOF : {}) };
        if (before) await tx.employeeAttendance.update({ where: { id: before.id }, data });
        else await tx.employeeAttendance.create({ data: { id: newId(), employeeId: e.employeeId, day: date, createdAt: now, ...data } });
        saved++;
      }
      return { saved, cleared, orphanProofs };
    });
  }

  async setProof(id: string, proof: AttendanceProof | null, sha256: string | null, now: Date) {
    const before = await this.db.employeeAttendance.findUnique({ where: { id }, select: { proofStorageKey: true } });
    await this.db.employeeAttendance.update({
      where: { id },
      data: proof
        ? { proofName: proof.name, proofMimeType: proof.mimeType, proofSize: proof.size, proofSha256: sha256, proofStorageKey: proof.storageKey, proofUploadedAt: proof.uploadedAt, updatedAt: now }
        : { ...NO_PROOF, updatedAt: now },
    });
    return before?.proofStorageKey ?? null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  async recordMany(events: { type: string; subjectId: string; details: Record<string, unknown> }[], actorId: string | null, now: Date) {
    if (!events.length) return;
    await this.db.schoolActivity.createMany({ data: events.map((e) => ({ id: randomUUID(), type: e.type, subjectId: e.subjectId, actorId, details: e.details as Prisma.InputJsonValue, occurredAt: now })) });
  }
}
