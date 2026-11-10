import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SchoolUser as SchoolUserRow } from ".prisma/tenant-client";
import { EmailAddress, FullName, type LoginIdentifier, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import { EmailCode } from "../domain/EmailCode";
import type { EmailCodeRepository, SchoolSessionRepository, SchoolUserRepository } from "../domain/repositories";
import { SchoolSession } from "../domain/SchoolSession";
import { type EmailCodePurpose, SchoolUser } from "../domain/SchoolUser";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mapper persistência ⇄ domínio. Os dados na BD já foram validados ao gravar. */
function toDomain(row: SchoolUserRow): SchoolUser {
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false }) => {
    if (!r.ok) throw new Error(`Registo inválido em school_users (${row.id})`);
    return r.value;
  };
  return SchoolUser.restore({
    id: row.id,
    fullName: unwrap(FullName.create(row.fullName)),
    email: row.email ? unwrap(EmailAddress.create(row.email)) : null,
    // telefones já estão em E.164: o indicativo por omissão não se aplica
    phone: row.phone ? unwrap(PhoneNumber.create(row.phone, "")) : null,
    passwordHash: row.passwordHash,
    role: row.role,
    status: row.status,
    isOwner: row.isOwner,
    failedLoginAttempts: row.failedLoginAttempts,
    lockedUntil: row.lockedUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    mfa: {
      secretCiphertext: row.mfaSecretCiphertext,
      pendingSecretCiphertext: row.mfaPendingSecretCiphertext,
      enabledAt: row.mfaEnabledAt,
      lastUsedStep: row.mfaLastUsedStep,
      recoveryCodeHashes: row.mfaRecoveryCodeHashes,
    },
  });
}

export class PrismaSchoolUserRepository implements SchoolUserRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(id: string) {
    if (!UUID.test(id)) return null;
    const row = await this.db.schoolUser.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByIdentifier(identifier: LoginIdentifier) {
    const row = await this.db.schoolUser.findUnique({
      where: identifier.kind === "email" ? { email: identifier.value } : { phone: identifier.value },
    });
    return row ? toDomain(row) : null;
  }

  async save(user: SchoolUser) {
    const data = {
      fullName: user.fullName.value,
      email: user.email?.value ?? null,
      phone: user.phone?.value ?? null,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status,
      isOwner: user.isOwner,
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
      lastLoginAt: user.lastLoginAt,
      mfaSecretCiphertext: user.mfa.secretCiphertext,
      mfaPendingSecretCiphertext: user.mfa.pendingSecretCiphertext,
      mfaEnabledAt: user.mfa.enabledAt,
      mfaLastUsedStep: user.mfa.lastUsedStep,
      mfaRecoveryCodeHashes: [...user.mfa.recoveryCodeHashes],
    };
    const events = user.pullEvents();
    // agregado + histórico na mesma transação
    await this.db.$transaction([
      this.db.schoolUser.upsert({ where: { id: user.id }, create: { id: user.id, createdAt: user.createdAt, ...data }, update: data }),
      ...(events.length
        ? [
            this.db.schoolActivity.createMany({
              data: events.map((e) => ({
                id: randomUUID(),
                type: e.type,
                subjectId: e.subjectId,
                actorId: e.actorId,
                details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
                occurredAt: e.occurredAt,
              })),
            }),
          ]
        : []),
    ]);
  }
}

export class PrismaSchoolSessionRepository implements SchoolSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(id: string) {
    if (!UUID.test(id)) return null;
    const row = await this.db.schoolSession.findUnique({ where: { id } });
    return row ? SchoolSession.restore(row) : null;
  }

  async save(session: SchoolSession) {
    const { id, ...data } = session.snapshot;
    await this.db.schoolSession.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  async touch(id: string, now: Date) {
    await this.db.schoolSession.update({ where: { id }, data: { lastSeenAt: now } });
  }

  async revokeAll(userId: string, reason: string, now: Date, exceptId?: string) {
    const { count } = await this.db.schoolSession.updateMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now }, ...(exceptId && { NOT: { id: exceptId } }) },
      data: { revokedAt: now, revokedReason: reason },
    });
    return count;
  }
}

export class PrismaEmailCodeRepository implements EmailCodeRepository {
  constructor(private readonly db: PrismaClient) {}

  async latest(userId: string, purpose: EmailCodePurpose) {
    const row = await this.db.emailCode.findFirst({ where: { userId, purpose }, orderBy: { createdAt: "desc" } });
    return row ? EmailCode.restore(row) : null;
  }

  async stats(userId: string, purpose: EmailCodePurpose, since: Date) {
    const agg = await this.db.emailCode.aggregate({
      where: { userId, purpose, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { attempts: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    return {
      codesInWindow: agg._count._all,
      failuresInWindow: agg._sum.attempts ?? 0,
      oldestInWindowAt: agg._min.createdAt,
      lastCreatedAt: agg._max.createdAt,
    };
  }

  async save(code: EmailCode) {
    const { id, ...data } = code.snapshot;
    await this.db.emailCode.upsert({ where: { id }, create: { id, ...data }, update: { attempts: data.attempts, consumedAt: data.consumedAt } });
  }
}
