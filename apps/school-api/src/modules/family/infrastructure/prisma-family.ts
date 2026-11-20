import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";
import type { OtpStats } from "../../../../../../libs/kernel/src/domain/email-otp";
import type { FamilyAccountRow, FamilyCodeRow, FamilyRepository, HandoverRow, LinkedStudent, NotificationRow } from "../application/ports";
import type { AccountKind, CodePurpose, FamilyStatus, StudentStatus } from "../domain/family";
import { notifyFamily } from "./family-notify";

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

  // ---------------------------------------------------------------- notificações

  async notifications(accountId: string, limit: number): Promise<NotificationRow[]> {
    const rows = await this.db.$queryRaw<{ id: string; kind: string; title: string; body: string | null; link: string | null; student_id: string | null; read_at: Date | null; created_at: Date }[]>`
      SELECT id, kind, title, body, link, student_id, read_at, created_at FROM family_notifications
       WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, studentId: r.student_id, readAt: r.read_at, createdAt: r.created_at }));
  }

  async unreadCount(accountId: string) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM family_notifications WHERE account_id = ${accountId}::uuid AND read_at IS NULL`;
    return r?.n ?? 0;
  }

  async markRead(accountId: string, ids: string[] | null, now: Date) {
    const r = ids
      ? await this.db.$executeRaw`UPDATE family_notifications SET read_at = ${now} WHERE account_id = ${accountId}::uuid AND read_at IS NULL AND id = ANY(${ids}::uuid[])`
      : await this.db.$executeRaw`UPDATE family_notifications SET read_at = ${now} WHERE account_id = ${accountId}::uuid AND read_at IS NULL`;
    return r;
  }

  async notify(n: Parameters<FamilyRepository["notify"]>[0]) {
    await notifyFamily(this.db, n);
  }

  // ---------------------------------------------------------------- passar a conta ao aluno (18 anos)

  async handoverTarget(accountId: string, studentId: string) {
    const [r] = await this.db.$queryRaw<{ id: string; full_name: string; birth_date: Date; account_id: string | null; managing: boolean }[]>`
      SELECT s.id, s.full_name, s.birth_date, s.account_id,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                      WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing
        FROM students s WHERE s.id = ${studentId}::uuid`;
    return r ? { id: r.id, fullName: r.full_name, birthDate: r.birth_date.toISOString().slice(0, 10), hasAccount: !!r.account_id, managing: !!r.managing } : null;
  }

  async handovers(studentIds: string[]): Promise<HandoverRow[]> {
    if (!studentIds.length) return [];
    const rows = await this.db.$queryRaw<{ id: string; student_id: string; email: string; status: string; created_at: Date; completed_at: Date | null; has_account: boolean }[]>`
      SELECT DISTINCT ON (h.student_id) h.id, h.student_id, h.email, h.status, h.created_at, h.completed_at, (s.account_id IS NOT NULL) AS has_account
        FROM student_handovers h JOIN students s ON s.id = h.student_id
       WHERE h.student_id = ANY(${studentIds}::uuid[]) AND h.status <> 'CANCELLED'
       ORDER BY h.student_id, h.created_at DESC`;
    return rows.map((r) => ({ id: r.id, studentId: r.student_id, email: r.email, status: r.status as HandoverRow["status"], createdAt: r.created_at, completedAt: r.completed_at, studentHasAccount: !!r.has_account }));
  }

  async createHandover(input: { id: string; studentId: string; email: string; createdById: string; now: Date }) {
    await this.db.$transaction([
      this.db.$executeRaw`UPDATE student_handovers SET status = 'CANCELLED' WHERE student_id = ${input.studentId}::uuid AND status = 'PENDING'`,
      this.db.$executeRaw`INSERT INTO student_handovers (id, student_id, email, created_by_id, status, created_at)
                          VALUES (${input.id}::uuid, ${input.studentId}::uuid, ${input.email}, ${input.createdById}::uuid, 'PENDING', ${input.now})`,
    ]);
  }

  async pendingHandovers(email: string) {
    const rows = await this.db.$queryRaw<{ id: string; student_id: string; created_by_id: string | null; birth_date: Date; full_name: string; account_id: string | null }[]>`
      SELECT h.id, h.student_id, h.created_by_id, s.birth_date, s.full_name, s.account_id
        FROM student_handovers h JOIN students s ON s.id = h.student_id
       WHERE lower(h.email) = lower(${email}) AND h.status = 'PENDING'`;
    return rows.map((r) => ({ id: r.id, studentId: r.student_id, createdById: r.created_by_id, studentBirthDate: r.birth_date.toISOString().slice(0, 10), studentName: r.full_name, studentHasAccount: !!r.account_id }));
  }

  /** O registo do aluno passa a ser da conta (só se ainda não tiver dono) e o convite fica feito. */
  async completeHandover(input: { id: string; studentId: string; accountId: string; now: Date }) {
    return this.db.$transaction(async (tx) => {
      const done = await tx.$executeRaw`UPDATE students SET account_id = ${input.accountId}::uuid, updated_at = ${input.now}
                                          WHERE id = ${input.studentId}::uuid AND account_id IS NULL
                                            AND NOT EXISTS (SELECT 1 FROM students x WHERE x.account_id = ${input.accountId}::uuid)`;
      if (done !== 1) return false;
      // as inscrições (e renovações) do aluno passam com ele: o encarregado deixa de as ver
      await tx.$executeRaw`UPDATE applications SET account_id = ${input.accountId}::uuid WHERE student_id = ${input.studentId}::uuid`;
      // os avisos antigos do encarregado sobre este aluno ficam, mas sem ligação (já não as pode abrir)
      await tx.$executeRaw`UPDATE family_notifications SET link = NULL
                             WHERE student_id = ${input.studentId}::uuid AND account_id <> ${input.accountId}::uuid AND kind NOT LIKE 'HANDOVER%'`;
      await tx.$executeRaw`UPDATE student_handovers SET status = 'DONE', account_id = ${input.accountId}::uuid, completed_at = ${input.now} WHERE id = ${input.id}::uuid`;
      return true;
    });
  }
}
