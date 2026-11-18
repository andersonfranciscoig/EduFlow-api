import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";
import type { OtpStats } from "../../../../../../libs/kernel/src/domain/email-otp";
import type { FamilyAccountRow, FamilyCodeRow, FamilyRepository, LinkedStudent } from "../application/ports";
import type { AccountKind, CodePurpose, FamilyStatus, StudentStatus } from "../domain/family";

const toDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

type AccountSel = Prisma.FamilyAccountGetPayload<object>;
const toAccount = (a: AccountSel): FamilyAccountRow => ({
  id: a.id,
  email: a.email,
  fullName: a.fullName,
  phone: a.phone,
  passwordHash: a.passwordHash,
  kind: a.kind as AccountKind,
  birthDate: a.birthDate ? a.birthDate.toISOString().slice(0, 10) : null,
  status: a.status as FamilyStatus,
  failedLogins: a.failedLogins,
  lockedUntil: a.lockedUntil,
  lastLoginAt: a.lastLoginAt,
  createdAt: a.createdAt,
});

/** Contas de família na BD do PRÓPRIO colégio. */
export class PrismaFamilyRepository implements FamilyRepository {
  constructor(private readonly db: PrismaClient) {}

  async byEmail(email: string) {
    const a = await this.db.familyAccount.findUnique({ where: { email } });
    return a ? toAccount(a) : null;
  }

  async byId(id: string) {
    const a = await this.db.familyAccount.findUnique({ where: { id } });
    return a ? toAccount(a) : null;
  }

  async create(input: Parameters<FamilyRepository["create"]>[0]) {
    await this.db.familyAccount.create({
      data: {
        id: input.id,
        email: input.email,
        fullName: input.fullName,
        phone: input.phone,
        passwordHash: input.passwordHash,
        kind: input.kind,
        birthDate: toDate(input.birthDate),
        status: "PENDING",
        createdAt: input.now,
        updatedAt: input.now,
      },
    });
  }

  async update(id: string, set: Parameters<FamilyRepository["update"]>[1]) {
    const { now, birthDate, ...rest } = set;
    await this.db.familyAccount.update({ where: { id }, data: { ...rest, ...(birthDate !== undefined ? { birthDate: toDate(birthDate) } : {}), updatedAt: now } });
  }

  async saveCode(c: FamilyCodeRow) {
    const data = { accountId: c.accountId, purpose: c.purpose, codeHash: c.codeHash, attempts: c.attempts, expiresAt: c.expiresAt, consumedAt: c.consumedAt, createdAt: c.createdAt };
    await this.db.familyCode.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: { attempts: c.attempts, consumedAt: c.consumedAt } });
  }

  async latestCode(accountId: string, purpose: CodePurpose) {
    const c = await this.db.familyCode.findFirst({ where: { accountId, purpose }, orderBy: { createdAt: "desc" } });
    return c ? { ...c, purpose: c.purpose as CodePurpose } : null;
  }

  async codeStats(accountId: string, purpose: CodePurpose, since: Date): Promise<OtpStats> {
    const rows = await this.db.familyCode.findMany({ where: { accountId, purpose, createdAt: { gte: since } }, select: { createdAt: true, attempts: true, consumedAt: true }, orderBy: { createdAt: "asc" } });
    return {
      lastCreatedAt: rows.length ? rows[rows.length - 1].createdAt : null,
      oldestInWindowAt: rows.length ? rows[0].createdAt : null,
      codesInWindow: rows.length,
      // as tentativas de um código acertado: só as erradas contam
      failuresInWindow: rows.reduce((n, r) => n + (r.consumedAt ? Math.max(0, r.attempts) : r.attempts), 0),
    };
  }

  async openSession(input: { id: string; accountId: string; ip: string | null; userAgent: string | null; now: Date; expiresAt: Date }) {
    await this.db.familySession.create({ data: { id: input.id, accountId: input.accountId, ip: input.ip, userAgent: input.userAgent, createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt } });
  }

  async touchSession(sessionId: string, accountId: string, now: Date, expiresAt: Date) {
    const r = await this.db.familySession.updateMany({ where: { id: sessionId, accountId, revokedAt: null, expiresAt: { gt: now } }, data: { lastSeenAt: now, expiresAt } });
    return r.count > 0;
  }

  async revokeSession(sessionId: string, now: Date) {
    await this.db.familySession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  }

  async revokeAll(accountId: string, now: Date) {
    await this.db.familySession.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } });
  }

  async linkedStudents(accountId: string): Promise<LinkedStudent[]> {
    const [own, guardian] = await Promise.all([
      this.db.student.findUnique({ where: { accountId } }),
      this.db.guardian.findUnique({ where: { accountId }, include: { students: { include: { student: true } } } }),
    ]);
    const out: LinkedStudent[] = [];
    const base = (s: NonNullable<typeof own>) => ({ id: s.id, number: s.number, fullName: s.fullName, birthDate: s.birthDate.toISOString().slice(0, 10), gender: s.gender, status: s.status as StudentStatus });
    if (own) out.push({ ...base(own), self: true, managingGuardian: false, relationship: null });
    for (const link of guardian?.students ?? []) {
      if (own && link.studentId === own.id) continue;
      out.push({ ...base(link.student), self: false, managingGuardian: link.canManage, relationship: link.relationship === "Outro" ? link.relationshipOther : link.relationship });
    }
    return out.sort((a, b) => Number(b.self) - Number(a.self) || a.fullName.localeCompare(b.fullName));
  }

  async guardianOf(accountId: string) {
    return this.db.guardian.findUnique({ where: { accountId }, select: { id: true, fullName: true } });
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
