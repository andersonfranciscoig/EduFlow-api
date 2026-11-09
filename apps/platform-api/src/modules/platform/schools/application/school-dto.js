"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHOOL_STATUS_LABELS = void 0;
exports.cycleLabel = cycleLabel;
exports.toSchoolSummary = toSchoolSummary;
exports.toSchoolDetail = toSchoolDetail;
exports.toPortalView = toPortalView;
exports.SCHOOL_STATUS_LABELS = {
    PENDING_REVIEW: "Por validar",
    AWAITING_PAYMENT: "A aguardar pagamento",
    PAYMENT_UNDER_REVIEW: "Pagamento por verificar",
    ACTIVE: "Ativo",
    REJECTED: "Rejeitado",
};
const CYCLE_LABELS = { MONTHLY: "Mensal", QUARTERLY: "Trimestral", ANNUAL: "Anual" };
function cycleLabel(cycle, months) {
    if (CYCLE_LABELS[cycle])
        return CYCLE_LABELS[cycle];
    return months % 12 === 0 ? `${months / 12} ano${months === 12 ? "" : "s"}` : `${months} ${months === 1 ? "mês" : "meses"}`;
}
function orderDto(o) {
    const ins = o.instructions;
    return {
        id: o.id,
        number: o.number,
        plan: { id: o.planId, name: o.planName, monthlyPrice: o.planMonthlyPrice },
        cycle: o.cycle,
        cycleLabel: cycleLabel(o.cycle, o.months),
        months: o.months,
        subtotal: o.subtotal,
        discountPct: o.discountPct,
        total: o.total,
        status: o.status,
        paymentMethod: ins?.method ?? null,
        reference: ins?.method === "REFERENCE"
            ? { entity: ins.entity, reference: ins.reference, expiresAt: ins.expiresAt.toISOString(), expired: ins.expiresAt < new Date() }
            : null,
        transfer: ins?.method === "TRANSFER" ? { bankName: ins.bankName, holder: ins.holder, iban: ins.iban } : null,
        proof: o.proof
            ? {
                transactionNumber: o.proof.transactionNumber,
                fileName: o.proof.fileName,
                mimeType: o.proof.mimeType,
                submittedAt: o.proof.submittedAt.toISOString(),
            }
            : null,
        proofRejectionReason: o.proofRejectionReason,
        paidAt: o.paidAt?.toISOString() ?? null,
        createdAt: o.createdAt.toISOString(),
    };
}
function toSchoolSummary(school) {
    const s = school.snapshot;
    const order = school.currentOrder;
    return {
        id: s.id,
        name: s.name,
        nif: s.nif,
        province: s.province,
        municipality: s.municipality,
        ownerName: s.ownerName,
        ownerEmail: s.ownerEmail,
        status: s.status,
        statusLabel: exports.SCHOOL_STATUS_LABELS[s.status],
        plan: order?.planName ?? null,
        total: order?.total ?? null,
        cycleLabel: order ? cycleLabel(order.cycle, order.months) : null,
        subscriptionEndsAt: s.subscriptionEndsAt?.toISOString() ?? null,
        slug: s.slug,
        createdAt: s.createdAt.toISOString(),
    };
}
function toSchoolDetail(school, activity) {
    const s = school.snapshot;
    return {
        ...toSchoolSummary(school),
        phone: s.phone,
        address: s.address,
        rejectionReason: s.rejectionReason,
        currentOrder: school.currentOrder ? orderDto(school.currentOrder) : null,
        orders: s.orders.map(orderDto),
        activity: activity.map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() })),
    };
}
function toPortalView(school, activity, extras) {
    const detail = toSchoolDetail(school, activity);
    return {
        ...detail,
        activity: detail.activity.map(({ actor: _actor, ...rest }) => rest),
        paymentInfo: extras,
    };
}
//# sourceMappingURL=school-dto.js.map