import type { PrismaClient } from ".prisma/platform-client";
import type { EmailVerificationRepository } from "../application/EmailVerificationService";
import { EmailVerification, type VerificationPurpose } from "../domain/EmailVerification";

export class PrismaEmailVerificationRepository implements EmailVerificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async latest(purpose: VerificationPurpose, email: string) {
    const row = await this.prisma.emailVerification.findFirst({ where: { purpose, email }, orderBy: { createdAt: "desc" } });
    return row ? EmailVerification.restore(row) : null;
  }

  async stats(purpose: VerificationPurpose, email: string, since: Date) {
    const agg = await this.prisma.emailVerification.aggregate({
      where: { purpose, email, createdAt: { gte: since } },
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

  async save(v: EmailVerification) {
    const { id, ...data } = v.snapshot;
    await this.prisma.emailVerification.upsert({
      where: { id },
      create: { id, ...data },
      update: { attempts: data.attempts, verifiedAt: data.verifiedAt, proofHash: data.proofHash, proofExpiresAt: data.proofExpiresAt },
    });
  }

  async consumeProof(purpose: VerificationPurpose, email: string, proofHash: string, now: Date) {
    // atómico: dois pedidos com a mesma prova → só um a consegue usar
    const { count } = await this.prisma.emailVerification.updateMany({
      where: { purpose, email, proofHash, proofUsedAt: null, proofExpiresAt: { gt: now } },
      data: { proofUsedAt: now },
    });
    return count === 1;
  }
}
