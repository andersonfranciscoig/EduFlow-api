import { randomUUID } from "node:crypto";
import { type EmployeeDocument, Prisma, type PrismaClient } from ".prisma/tenant-client";
import type {
  ApplicantAccessRepository,
  EmployeeDocumentRow,
  EmployeeListRow,
  EmployeeRepository,
  EmployeeRow,
  StepPatch,
  Transition,
  TransitionOutcome,
} from "../application/employee-ports";
import { EMPLOYEE_STATUSES, type EmployeeStatus, type PersonalData, type Progress, type SectionsData, type StepKey } from "../domain/employee";
import type { FormSnapshot } from "../domain/form";

type Tx = Prisma.TransactionClient;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const INCLUDE = {
  employeeType: { select: { name: true } },
  formVersion: { select: { id: true, number: true, snapshot: true } },
  documents: { orderBy: { createdAt: "asc" } },
  user: { select: { id: true, status: true, email: true } },
} as const satisfies Prisma.EmployeeInclude;
type Row = Prisma.EmployeeGetPayload<{ include: typeof INCLUDE }>;

const docRow = (d: EmployeeDocument): EmployeeDocumentRow => ({
  id: d.id,
  slot: d.slot as EmployeeDocumentRow["slot"],
  itemId: d.itemId,
  label: d.label,
  fileName: d.fileName,
  mimeType: d.mimeType,
  size: d.size,
  storageKey: d.storageKey,
  uploadedById: d.uploadedById,
  createdAt: d.createdAt,
});

function base(r: Omit<Row, "formVersion" | "documents" | "personal" | "sections" | "user">) {
  return {
    id: r.id,
    number: r.number,
    requestId: r.requestId,
    employeeTypeId: r.employeeTypeId,
    employeeTypeName: r.employeeType?.name ?? null,
    status: r.status as EmployeeStatus,
    progress: r.progress as Progress,
    lastStep: r.lastStep as StepKey | null,
    completedSteps: r.completedSteps as StepKey[],
    revision: r.revision,
    fullName: r.fullName,
    email: r.email,
    phone: r.phone,
    jobTitle: r.jobTitle,
    department: r.department,
    correctionNote: r.correctionNote,
    createdById: r.createdById,
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
    activatedAt: r.activatedAt,
    terminatedAt: r.terminatedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const toRow = (r: Row): EmployeeRow => ({
  ...base(r),
  formVersion: { id: r.formVersion.id, number: r.formVersion.number, snapshot: r.formVersion.snapshot as unknown as FormSnapshot },
  personal: (r.personal ?? {}) as PersonalData,
  sections: (r.sections ?? {}) as SectionsData,
  documents: r.documents.map(docRow),
  portalUser: r.user ? { id: r.user.id, status: r.user.status, email: r.user.email } : null,
});

/** Cadastros na BD do PRÓPRIO colégio (a ligação já é a deste colégio — TenantGuard). */
export class PrismaEmployeeRepository implements EmployeeRepository {
  constructor(private readonly db: PrismaClient) {}

  async find(id: string) {
    const r = await this.db.employee.findUnique({ where: { id }, include: INCLUDE });
    return r ? toRow(r) : null;
  }

  async findByRequest(requestId: string) {
    const r = await this.db.employee.findUnique({ where: { requestId }, include: INCLUDE });
    return r ? toRow(r) : null;
  }

  async list(input: { status: EmployeeStatus | null; q: string | null; typeId: string | null; page: number; pageSize: number }) {
    const q = input.q;
    const digits = q?.replace(/\D/g, "");
    const where: Prisma.EmployeeWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.typeId ? { employeeTypeId: input.typeId } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { email: { contains: q.toLowerCase() } },
              { jobTitle: { contains: q, mode: "insensitive" } },
              { department: { contains: q, mode: "insensitive" } },
              ...(digits ? [{ phone: { contains: digits } }] : []),
              ...(digits && digits.length <= 9 && /^\d+$/.test(q.trim()) ? [{ number: Number(digits) }] : []),
            ],
          }
        : {}),
    };
    const [rows, total, grouped] = await Promise.all([
      this.db.employee.findMany({
        where,
        include: { employeeType: { select: { name: true } }, documents: { where: { slot: "PHOTO" }, select: { id: true } } },
        orderBy: [{ number: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.db.employee.count({ where }),
      this.db.employee.groupBy({ by: ["status"], _count: { _all: true }, ...(input.typeId ? { where: { employeeTypeId: input.typeId } } : {}) }),
    ]);
    const counts = Object.fromEntries(EMPLOYEE_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<EmployeeStatus, number>;
    const items: EmployeeListRow[] = rows.map((r) => ({ ...base(r), hasPhoto: r.documents.length > 0, photoId: r.documents[0]?.id ?? null }));
    return { items, total, counts };
  }

  async create(input: Parameters<EmployeeRepository["create"]>[0]) {
    try {
      const row = await this.db.$transaction(async (tx) => {
        const r = await tx.employee.create({
          data: {
            id: input.id,
            requestId: input.requestId,
            employeeTypeId: input.employeeTypeId,
            formVersionId: input.formVersionId,
            status: "DRAFT",
            progress: "NOT_STARTED",
            personal: input.personal as Prisma.InputJsonValue,
            sections: {},
            fullName: input.fullName,
            email: input.email,
            phone: input.phone,
            createdById: input.createdById,
            createdAt: input.now,
            updatedAt: input.now,
          },
          include: INCLUDE,
        });
        await this.history_(tx, { employeeId: r.id, from: null, to: "DRAFT", actorId: input.createdById, actorName: input.actorName, reason: input.requestId ? "Primeiro acesso pelo convite." : "Criado pelo RH.", now: input.now });
        return r;
      });
      return { ok: true as const, value: toRow(row) };
    } catch (e) {
      if (isUnique(e)) return { ok: false as const, reason: "duplicate" as const };
      throw e;
    }
  }

  async saveStep(id: string, expectedRevision: number, allowed: EmployeeStatus[], p: StepPatch) {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; revision: number; sections: unknown }[]>`SELECT "status", "revision", "sections" FROM "employees" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const cur = rows[0];
      if (!cur) return { ok: false as const, reason: "not_found" as const };
      if (!allowed.includes(cur.status as EmployeeStatus)) return { ok: false as const, reason: "state" as const };
      if (cur.revision !== expectedRevision) return { ok: false as const, reason: "conflict" as const };
      const data: Prisma.EmployeeUpdateInput = {
        revision: { increment: 1 },
        completedSteps: p.completedSteps,
        lastStep: p.lastStep,
        progress: p.progress,
        updatedAt: p.now,
      };
      if (p.personal) data.personal = p.personal as Prisma.InputJsonValue;
      if (p.section) data.sections = { ...((cur.sections ?? {}) as SectionsData), [p.section.key]: p.section.entries } as Prisma.InputJsonValue;
      if (p.fullName) data.fullName = p.fullName;
      if (p.email !== undefined) data.email = p.email;
      if (p.phone !== undefined) data.phone = p.phone;
      const r = await tx.employee.update({ where: { id }, data, select: { revision: true, updatedAt: true } });
      return { ok: true as const, revision: r.revision, updatedAt: r.updatedAt };
    });
  }

  /** Muda o estado com a linha bloqueada (duas decisões ao mesmo tempo não passam as duas). */
  async transition(t: Transition): Promise<TransitionOutcome> {
    const done = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; revision: number }[]>`SELECT "status", "revision" FROM "employees" WHERE "id" = ${t.id}::uuid FOR UPDATE`;
      const cur = rows[0];
      if (!cur) return { ok: false, reason: "not_found" } as const;
      const status = cur.status as EmployeeStatus;
      if (!t.from.includes(status)) return { ok: false, reason: "state", status } as const;
      if (t.revision !== undefined && cur.revision !== t.revision) return { ok: false, reason: "conflict" } as const;
      await tx.employee.update({ where: { id: t.id }, data: { status: t.to, updatedAt: t.now, revision: { increment: 1 }, ...(t.set ?? {}) } });
      // n.º de funcionário: o seguinte da sequência deste colégio (só uma vez)
      if (t.assignNumber) await tx.$executeRaw`UPDATE "employees" SET "number" = nextval('employee_number_seq') WHERE "id" = ${t.id}::uuid AND "number" IS NULL`;
      await this.history_(tx, { employeeId: t.id, from: status, to: t.to, actorId: t.actorId, actorName: t.actorName, reason: t.reason, now: t.now });
      return { ok: true } as const;
    });
    if (!done.ok) return done;
    return { ok: true, value: (await this.find(t.id))! };
  }

  async updateAdmin(id: string, input: { jobTitle: string | null; department: string | null; now: Date }) {
    const r = await this.db.employee.updateMany({ where: { id }, data: { jobTitle: input.jobTitle, department: input.department, updatedAt: input.now } });
    return r.count > 0;
  }

  async history(id: string) {
    const rows = await this.db.employeeApprovalHistory.findMany({ where: { subjectType: "EMPLOYEE", subjectId: id }, orderBy: { createdAt: "asc" } });
    return rows.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, actorName: h.actorName, reason: h.reason, createdAt: h.createdAt }));
  }

  async addHistory(h: Parameters<EmployeeRepository["addHistory"]>[0]) {
    await this.history_(this.db, h);
  }

  private async history_(tx: Tx | PrismaClient, h: { employeeId: string; from: string | null; to: string; actorId: string | null; actorName: string | null; reason: string | null; now: Date }) {
    await tx.employeeApprovalHistory.create({
      data: { id: randomUUID(), subjectType: "EMPLOYEE", subjectId: h.employeeId, fromStatus: h.from, toStatus: h.to, actorId: h.actorId, actorName: h.actorName, reason: h.reason?.slice(0, 500) ?? null, createdAt: h.now },
    });
  }

  async addDocument(employeeId: string, d: Omit<EmployeeDocumentRow, "createdAt"> & { sha256: string; now: Date }) {
    await this.db.employeeDocument.create({
      data: {
        id: d.id,
        employeeId,
        slot: d.slot,
        itemId: d.itemId,
        label: d.label.slice(0, 120),
        fileName: d.fileName,
        mimeType: d.mimeType,
        size: d.size,
        sha256: d.sha256,
        storageKey: d.storageKey,
        uploadedById: d.uploadedById,
        createdAt: d.now,
      },
    });
  }

  /** Só apaga se o ficheiro for DESTE funcionário. */
  async removeDocument(employeeId: string, docId: string) {
    const d = await this.db.employeeDocument.findFirst({ where: { id: docId, employeeId } });
    if (!d) return null;
    await this.db.employeeDocument.delete({ where: { id: d.id } });
    return docRow(d);
  }

  async recipients(permission: string) {
    const users = await this.db.schoolUser.findMany({
      where: { status: "ACTIVE", email: { not: null }, OR: [{ isOwner: true }, { permissions: { some: { permission } } }] },
      select: { email: true, fullName: true },
    });
    return users.map((u) => ({ email: u.email!, name: u.fullName }));
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}

/** Convites → sessão do formulário (o token em claro nunca chega à BD). */
export class PrismaApplicantAccess implements ApplicantAccessRepository {
  constructor(private readonly db: PrismaClient) {}

  async inviteByTokenHash(hash: string) {
    const i = await this.db.employeeRegistrationInvite.findUnique({
      where: { tokenHash: hash },
      include: { request: true, employeeType: { select: { name: true } } },
    });
    if (!i) return null;
    return {
      inviteId: i.id,
      requestId: i.requestId,
      requestStatus: i.request.status,
      fullName: i.request.fullName,
      email: i.request.email,
      phone: i.request.phone,
      passwordHash: i.request.passwordHash,
      employeeTypeId: i.employeeTypeId,
      employeeTypeName: i.employeeType?.name ?? null,
      expiresAt: i.expiresAt,
      revokedAt: i.revokedAt,
      failedAttempts: i.failedAttempts,
      lockedUntil: i.lockedUntil,
      expiredNotifiedAt: i.expiredNotifiedAt,
    };
  }

  async registerFailure(inviteId: string, maxAttempts: number, lockUntil: Date) {
    return this.db.$transaction(async (tx) => {
      const i = await tx.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { failedAttempts: { increment: 1 } } });
      if (i.failedAttempts >= maxAttempts) {
        await tx.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { failedAttempts: 0, lockedUntil: lockUntil } });
        return { attempts: i.failedAttempts, lockedUntil: lockUntil };
      }
      return { attempts: i.failedAttempts, lockedUntil: null };
    });
  }

  async startSession(inviteId: string, sessionHash: string, expiresAt: Date, now: Date) {
    await this.db.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { sessionHash, sessionExpiresAt: expiresAt, failedAttempts: 0, lockedUntil: null, lastUsedAt: now } });
  }

  async session(sessionHash: string, now: Date) {
    const i = await this.db.employeeRegistrationInvite.findUnique({ where: { sessionHash }, include: { request: { select: { status: true } } } });
    if (!i || !i.sessionExpiresAt || i.sessionExpiresAt <= now || i.revokedAt || i.request.status !== "APPROVED") return null;
    return { inviteId: i.id, requestId: i.requestId, expiresAt: i.sessionExpiresAt };
  }

  async extendSession(inviteId: string, expiresAt: Date) {
    await this.db.employeeRegistrationInvite.update({ where: { id: inviteId }, data: { sessionExpiresAt: expiresAt } });
  }

  async endSession(sessionHash: string) {
    await this.db.employeeRegistrationInvite.updateMany({ where: { sessionHash }, data: { sessionHash: null, sessionExpiresAt: null } });
  }

  async markExpiredNotified(inviteId: string, now: Date) {
    const r = await this.db.employeeRegistrationInvite.updateMany({ where: { id: inviteId, expiredNotifiedAt: null }, data: { expiredNotifiedAt: now } });
    return r.count > 0;
  }
}
