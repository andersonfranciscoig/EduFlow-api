import { randomUUID } from "node:crypto";
import type {
  Prisma,
  PrismaClient,
  School as SchoolRow,
  SubscriptionOrder as OrderRow,
} from ".prisma/platform-client";
import { School, type SchoolActivityType, type SchoolStatus, type SubscriptionOrder } from "../domain/School";
import type { SchoolActivityEntry, SchoolRepository } from "../domain/SchoolRepository";

const withOrders = { orders: { orderBy: { createdAt: "desc" } } } as const;

function orderToDomain(o: OrderRow): SubscriptionOrder {
  const instructions =
    o.paymentMethod === "REFERENCE" && o.referenceEntity && o.referenceNumber && o.referenceExpiresAt
      ? { method: "REFERENCE" as const, entity: o.referenceEntity, reference: o.referenceNumber, expiresAt: o.referenceExpiresAt }
      : o.paymentMethod === "TRANSFER" && o.bankName && o.bankHolder && o.bankIban
        ? { method: "TRANSFER" as const, bankName: o.bankName, holder: o.bankHolder, iban: o.bankIban }
        : null;

  return {
    id: o.id,
    number: o.number,
    planId: o.planId,
    planName: o.planName,
    planMonthlyPrice: o.planMonthlyPrice,
    cycle: o.cycle,
    months: o.months,
    subtotal: o.subtotal,
    discountPct: o.discountPct,
    total: o.total,
    status: o.status,
    instructions,
    proof:
      o.transactionNumber && o.proofKey && o.proofFileName && o.proofMimeType && o.proofSubmittedAt
        ? {
            transactionNumber: o.transactionNumber,
            fileKey: o.proofKey,
            fileName: o.proofFileName,
            mimeType: o.proofMimeType,
            submittedAt: o.proofSubmittedAt,
          }
        : null,
    proofRejectionReason: o.proofRejectionReason,
    paidAt: o.paidAt,
    createdAt: o.createdAt,
  };
}

function toDomain(row: SchoolRow & { orders: OrderRow[] }): School {
  return School.restore({
    id: row.id,
    name: row.name,
    nif: row.nif,
    phone: row.phone,
    province: row.province,
    municipality: row.municipality,
    address: row.address,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    ownerPasswordHash: row.ownerPasswordHash,
    slug: row.slug,
    status: row.status,
    rejectionReason: row.rejectionReason,
    subscriptionEndsAt: row.subscriptionEndsAt,
    createdAt: row.createdAt,
    orders: row.orders.map(orderToDomain),
  });
}

function orderData(o: SubscriptionOrder) {
  const ins = o.instructions;
  return {
    number: o.number,
    planId: o.planId,
    planName: o.planName,
    planMonthlyPrice: o.planMonthlyPrice,
    cycle: o.cycle,
    months: o.months,
    subtotal: o.subtotal,
    discountPct: o.discountPct,
    total: o.total,
    status: o.status,
    paymentMethod: ins?.method ?? null,
    referenceEntity: ins?.method === "REFERENCE" ? ins.entity : null,
    referenceNumber: ins?.method === "REFERENCE" ? ins.reference : null,
    referenceExpiresAt: ins?.method === "REFERENCE" ? ins.expiresAt : null,
    bankName: ins?.method === "TRANSFER" ? ins.bankName : null,
    bankHolder: ins?.method === "TRANSFER" ? ins.holder : null,
    bankIban: ins?.method === "TRANSFER" ? ins.iban : null,
    transactionNumber: o.proof?.transactionNumber ?? null,
    proofKey: o.proof?.fileKey ?? null,
    proofFileName: o.proof?.fileName ?? null,
    proofMimeType: o.proof?.mimeType ?? null,
    proofSubmittedAt: o.proof?.submittedAt ?? null,
    proofRejectionReason: o.proofRejectionReason,
    paidAt: o.paidAt,
  };
}

/** Escolhe o servidor de BD na ativação (fornecido pelo contexto "databases"). */
export type ActivationPlacement = (tx: Prisma.TransactionClient, schoolId: string) => Promise<string | null>;

export class PrismaSchoolRepository implements SchoolRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly placement: ActivationPlacement,
  ) {}

  async findById(id: string) {
    const row = await this.prisma.school.findUnique({ where: { id }, include: withOrders });
    return row ? toDomain(row) : null;
  }

  async findByOwnerEmail(email: string) {
    const row = await this.prisma.school.findUnique({ where: { ownerEmail: email }, include: withOrders });
    return row ? toDomain(row) : null;
  }

  async findByReference(reference: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({ where: { referenceNumber: reference }, select: { schoolId: true } });
    return order ? this.findById(order.schoolId) : null;
  }

  async ownerEmailExists(email: string) {
    return (await this.prisma.school.count({ where: { ownerEmail: email } })) > 0;
  }

  async nifExists(nif: string) {
    return (await this.prisma.school.count({ where: { nif } })) > 0;
  }

  async referenceExists(reference: string) {
    return (await this.prisma.subscriptionOrder.count({ where: { referenceNumber: reference } })) > 0;
  }

  async slugExists(slug: string) {
    return (await this.prisma.school.count({ where: { slug } })) > 0;
  }

  async list(filter: { status?: SchoolStatus } = {}) {
    const rows = await this.prisma.school.findMany({
      where: { status: filter.status },
      include: withOrders,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDomain);
  }

  async countByStatus() {
    const groups = await this.prisma.school.groupBy({ by: ["status"], _count: { _all: true } });
    const counts: Record<SchoolStatus, number> = {
      PENDING_REVIEW: 0,
      AWAITING_PAYMENT: 0,
      PAYMENT_UNDER_REVIEW: 0,
      ACTIVE: 0,
      REJECTED: 0,
    };
    for (const g of groups) counts[g.status] = g._count._all;
    return counts;
  }

  async activity(schoolId: string): Promise<SchoolActivityEntry[]> {
    const rows = await this.prisma.schoolActivity.findMany({
      where: { schoolId },
      orderBy: { occurredAt: "desc" },
      take: 50,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorStaffId).filter((v): v is string => !!v))];
    const actors = actorIds.length
      ? await this.prisma.staffMember.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type as SchoolActivityType,
      actor: r.actorStaffId ? (byId.get(r.actorStaffId) ?? null) : null,
      details: (r.details as Record<string, unknown> | null) ?? null,
      occurredAt: r.occurredAt,
    }));
  }

  async save(school: School) {
    const s = school.snapshot;
    const data = {
      slug: s.slug,
      name: s.name,
      nif: s.nif,
      phone: s.phone,
      province: s.province,
      municipality: s.municipality,
      address: s.address,
      ownerName: s.ownerName,
      ownerEmail: s.ownerEmail,
      ownerPasswordHash: s.ownerPasswordHash,
      status: s.status,
      rejectionReason: s.rejectionReason,
      subscriptionEndsAt: s.subscriptionEndsAt,
    };
    const events = school.pullEvents();
    const activated = events.some((e) => e.type === "SCHOOL_ACTIVATED");

    await this.prisma.$transaction(async (tx) => {
      await tx.school.upsert({
        where: { id: s.id },
        create: { id: s.id, createdAt: s.createdAt, ...data },
        update: data,
      });
      for (const o of s.orders) {
        await tx.subscriptionOrder.upsert({
          where: { id: o.id },
          create: { id: o.id, schoolId: s.id, createdAt: o.createdAt, ...orderData(o) },
          update: orderData(o),
        });
      }
      if (events.length) {
        await tx.schoolActivity.createMany({
          data: events.map((e) => ({
            id: randomUUID(),
            schoolId: s.id,
            type: e.type,
            actorStaffId: e.actorStaffId,
            details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
            occurredAt: e.occurredAt,
          })),
        });
      }
      // Outbox: colégio ativado → reserva passa a atribuição + pedido de criação
      // da sua base de dados, tudo na MESMA transação do pagamento.
      // (Só a primeira ativação cria o pedido; renovações não.)
      if (activated) {
        const serverId = await this.placement(tx, s.id);
        await tx.tenantProvisioningJob.upsert({
          where: { schoolId: s.id },
          create: { id: randomUUID(), schoolId: s.id, slug: s.slug ?? `colegio-${s.id.slice(0, 8)}`, schoolName: s.name, serverId },
          // um pedido que estava à espera de servidor fica com o que agora foi atribuído
          update: serverId ? { serverId } : {},
        });
      }
    });
  }
}
