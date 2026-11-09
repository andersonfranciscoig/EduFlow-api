"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaSchoolRepository = void 0;
const node_crypto_1 = require("node:crypto");
const School_1 = require("../domain/School");
const withOrders = { orders: { orderBy: { createdAt: "desc" } } };
function orderToDomain(o) {
    const instructions = o.paymentMethod === "REFERENCE" && o.referenceEntity && o.referenceNumber && o.referenceExpiresAt
        ? { method: "REFERENCE", entity: o.referenceEntity, reference: o.referenceNumber, expiresAt: o.referenceExpiresAt }
        : o.paymentMethod === "TRANSFER" && o.bankName && o.bankHolder && o.bankIban
            ? { method: "TRANSFER", bankName: o.bankName, holder: o.bankHolder, iban: o.bankIban }
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
        proof: o.transactionNumber && o.proofKey && o.proofFileName && o.proofMimeType && o.proofSubmittedAt
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
function toDomain(row) {
    return School_1.School.restore({
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
function orderData(o) {
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
class PrismaSchoolRepository {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findById(id) {
        const row = await this.prisma.school.findUnique({ where: { id }, include: withOrders });
        return row ? toDomain(row) : null;
    }
    async findByOwnerEmail(email) {
        const row = await this.prisma.school.findUnique({ where: { ownerEmail: email }, include: withOrders });
        return row ? toDomain(row) : null;
    }
    async findByReference(reference) {
        const order = await this.prisma.subscriptionOrder.findUnique({ where: { referenceNumber: reference }, select: { schoolId: true } });
        return order ? this.findById(order.schoolId) : null;
    }
    async ownerEmailExists(email) {
        return (await this.prisma.school.count({ where: { ownerEmail: email } })) > 0;
    }
    async nifExists(nif) {
        return (await this.prisma.school.count({ where: { nif } })) > 0;
    }
    async referenceExists(reference) {
        return (await this.prisma.subscriptionOrder.count({ where: { referenceNumber: reference } })) > 0;
    }
    async slugExists(slug) {
        return (await this.prisma.school.count({ where: { slug } })) > 0;
    }
    async list(filter = {}) {
        const rows = await this.prisma.school.findMany({
            where: { status: filter.status },
            include: withOrders,
            orderBy: { createdAt: "desc" },
        });
        return rows.map(toDomain);
    }
    async countByStatus() {
        const groups = await this.prisma.school.groupBy({ by: ["status"], _count: { _all: true } });
        const counts = {
            PENDING_REVIEW: 0,
            AWAITING_PAYMENT: 0,
            PAYMENT_UNDER_REVIEW: 0,
            ACTIVE: 0,
            REJECTED: 0,
        };
        for (const g of groups)
            counts[g.status] = g._count._all;
        return counts;
    }
    async activity(schoolId) {
        const rows = await this.prisma.schoolActivity.findMany({
            where: { schoolId },
            orderBy: { occurredAt: "desc" },
            take: 50,
        });
        const actorIds = [...new Set(rows.map((r) => r.actorStaffId).filter((v) => !!v))];
        const actors = actorIds.length
            ? await this.prisma.staffMember.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
            : [];
        const byId = new Map(actors.map((a) => [a.id, a]));
        return rows.map((r) => ({
            id: r.id,
            type: r.type,
            actor: r.actorStaffId ? (byId.get(r.actorStaffId) ?? null) : null,
            details: r.details ?? null,
            occurredAt: r.occurredAt,
        }));
    }
    async save(school) {
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
        await this.prisma.$transaction([
            this.prisma.school.upsert({
                where: { id: s.id },
                create: { id: s.id, createdAt: s.createdAt, ...data },
                update: data,
            }),
            ...s.orders.map((o) => this.prisma.subscriptionOrder.upsert({
                where: { id: o.id },
                create: { id: o.id, schoolId: s.id, createdAt: o.createdAt, ...orderData(o) },
                update: orderData(o),
            })),
            ...(events.length
                ? [
                    this.prisma.schoolActivity.createMany({
                        data: events.map((e) => ({
                            id: (0, node_crypto_1.randomUUID)(),
                            schoolId: s.id,
                            type: e.type,
                            actorStaffId: e.actorStaffId,
                            details: (e.details ?? undefined),
                            occurredAt: e.occurredAt,
                        })),
                    }),
                ]
                : []),
            ...(activated
                ? [
                    this.prisma.tenantProvisioningJob.upsert({
                        where: { schoolId: s.id },
                        create: { id: (0, node_crypto_1.randomUUID)(), schoolId: s.id, slug: s.slug ?? `colegio-${s.id.slice(0, 8)}`, schoolName: s.name },
                        update: {},
                    }),
                ]
                : []),
        ]);
    }
}
exports.PrismaSchoolRepository = PrismaSchoolRepository;
//# sourceMappingURL=PrismaSchoolRepository.js.map