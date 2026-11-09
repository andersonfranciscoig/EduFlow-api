"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.School = void 0;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("./errors");
function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
}
class School {
    props;
    events = [];
    constructor(props) {
        this.props = props;
    }
    static register(input) {
        const school = new School({
            id: input.id,
            slug: input.slug,
            ...input.data,
            ownerName: input.owner.name,
            ownerEmail: input.owner.email,
            ownerPasswordHash: input.ownerPasswordHash,
            status: "PENDING_REVIEW",
            rejectionReason: null,
            subscriptionEndsAt: null,
            createdAt: input.now,
            orders: [{ ...input.order, status: "PENDING_REVIEW", instructions: null, proof: null, proofRejectionReason: null, paidAt: null }],
        });
        school.record("SCHOOL_REGISTERED", null, input.now, {
            plan: input.order.planName,
            months: input.order.months,
            total: input.order.total,
        });
        return school;
    }
    static restore(props) {
        return new School({ ...props, orders: props.orders.map((o) => ({ ...o })) });
    }
    approve(instructions, staffId, now) {
        if (this.props.status !== "PENDING_REVIEW") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Este pedido já foi analisado."));
        }
        const order = this.currentOrder;
        order.status = "AWAITING_PAYMENT";
        order.instructions = instructions;
        this.props.status = "AWAITING_PAYMENT";
        this.record("SCHOOL_APPROVED", staffId, now, { method: instructions.method });
        return (0, Result_1.ok)(undefined);
    }
    reject(reason, staffId, now) {
        if (this.props.status !== "PENDING_REVIEW") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Só é possível rejeitar pedidos por validar."));
        }
        const text = reason.trim();
        if (text.length < 5)
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Indique o motivo da rejeição."));
        this.props.status = "REJECTED";
        this.props.rejectionReason = text;
        this.currentOrder.status = "CANCELLED";
        this.record("SCHOOL_REJECTED", staffId, now, { reason: text });
        return (0, Result_1.ok)(undefined);
    }
    changePaymentMethod(instructions, staffId, now) {
        const order = this.currentOrder;
        if (this.props.status !== "AWAITING_PAYMENT" || order?.status !== "AWAITING_PAYMENT") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Só é possível alterar a forma de pagamento enquanto se aguarda o pagamento."));
        }
        order.instructions = instructions;
        order.proofRejectionReason = null;
        this.record("PAYMENT_METHOD_CHANGED", staffId, now, { method: instructions.method });
        return (0, Result_1.ok)(undefined);
    }
    confirmTransferPayment(staffId, now) {
        const order = this.currentOrder;
        if (order?.status !== "PROOF_SUBMITTED") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Não há nenhum comprovativo por verificar."));
        }
        this.markPaid(order, "TRANSFER", staffId, now);
        return (0, Result_1.ok)(undefined);
    }
    rejectTransferProof(reason, staffId, now) {
        const order = this.currentOrder;
        if (order?.status !== "PROOF_SUBMITTED") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Não há nenhum comprovativo por verificar."));
        }
        const text = reason.trim();
        if (text.length < 5)
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Indique o motivo da rejeição."));
        order.status = "AWAITING_PAYMENT";
        order.proofRejectionReason = text;
        order.proof = null;
        this.props.status = "AWAITING_PAYMENT";
        this.record("PROOF_REJECTED", staffId, now, { reason: text });
        return (0, Result_1.ok)(undefined);
    }
    submitTransferProof(proof, now) {
        const order = this.currentOrder;
        if (order?.status !== "AWAITING_PAYMENT" || order.instructions?.method !== "TRANSFER") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "De momento não há nenhuma transferência por comprovar."));
        }
        const transactionNumber = proof.transactionNumber.trim();
        if (transactionNumber.length < 4) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_PROOF", "Indique o número da transação."));
        }
        order.proof = { ...proof, transactionNumber };
        order.proofRejectionReason = null;
        order.status = "PROOF_SUBMITTED";
        this.props.status = "PAYMENT_UNDER_REVIEW";
        this.record("PROOF_SUBMITTED", null, now, { transactionNumber });
        return (0, Result_1.ok)(undefined);
    }
    confirmReferencePayment(input, now) {
        const order = this.currentOrder;
        const ins = order?.instructions;
        if (!order || order.status !== "AWAITING_PAYMENT" || ins?.method !== "REFERENCE" || ins.reference !== input.reference) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("REFERENCE_NOT_FOUND", "Referência não encontrada ou já paga."));
        }
        if (ins.expiresAt < now) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("REFERENCE_EXPIRED", "Esta referência expirou. Peça uma nova à equipa EduFlow."));
        }
        if (input.amount !== order.total) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("AMOUNT_MISMATCH", "O valor pago não corresponde ao valor da referência.", { expected: order.total }));
        }
        this.markPaid(order, "REFERENCE", null, now);
        return (0, Result_1.ok)(undefined);
    }
    markPaid(order, method, staffId, now) {
        order.status = "PAID";
        order.paidAt = now;
        const base = this.props.subscriptionEndsAt && this.props.subscriptionEndsAt > now ? this.props.subscriptionEndsAt : now;
        this.props.subscriptionEndsAt = addMonths(base, order.months);
        this.props.status = "ACTIVE";
        this.record("PAYMENT_CONFIRMED", staffId, now, { method, amount: order.total, automatic: method === "REFERENCE" });
        this.record("SCHOOL_ACTIVATED", staffId, now, { until: this.props.subscriptionEndsAt.toISOString() });
    }
    record(type, actorStaffId, now, details) {
        this.events.push({ type, actorStaffId, details, occurredAt: now });
    }
    pullEvents() {
        const events = this.events;
        this.events = [];
        return events;
    }
    get id() { return this.props.id; }
    get slug() { return this.props.slug; }
    get status() { return this.props.status; }
    get ownerEmail() { return this.props.ownerEmail; }
    get ownerPasswordHash() { return this.props.ownerPasswordHash; }
    get currentOrder() { return this.props.orders[0]; }
    get snapshot() { return this.props; }
}
exports.School = School;
//# sourceMappingURL=School.js.map