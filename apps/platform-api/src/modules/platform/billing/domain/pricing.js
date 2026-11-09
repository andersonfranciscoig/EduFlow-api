"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_CUSTOM_YEARS = exports.MAX_CUSTOM_MONTHS = exports.CYCLE_KINDS = void 0;
exports.createCycle = createCycle;
exports.quote = quote;
exports.describeCycle = describeCycle;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("./errors");
exports.CYCLE_KINDS = ["MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"];
exports.MAX_CUSTOM_MONTHS = 36;
exports.MAX_CUSTOM_YEARS = 5;
function createCycle(input) {
    switch (input.kind) {
        case "MONTHLY":
            return (0, Result_1.ok)({ kind: "MONTHLY", months: 1 });
        case "QUARTERLY":
            return (0, Result_1.ok)({ kind: "QUARTERLY", months: 3 });
        case "ANNUAL":
            return (0, Result_1.ok)({ kind: "ANNUAL", months: 12 });
        case "CUSTOM": {
            const q = input.quantity ?? 0;
            const unit = input.unit ?? "MONTHS";
            const max = unit === "YEARS" ? exports.MAX_CUSTOM_YEARS : exports.MAX_CUSTOM_MONTHS;
            if (!Number.isInteger(q) || q < 1 || q > max) {
                return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_CYCLE", unit === "YEARS" ? `Escolha entre 1 e ${exports.MAX_CUSTOM_YEARS} anos.` : `Escolha entre 1 e ${exports.MAX_CUSTOM_MONTHS} meses.`));
            }
            return (0, Result_1.ok)({ kind: "CUSTOM", months: unit === "YEARS" ? q * 12 : q });
        }
        default:
            return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_CYCLE", "Periodicidade inválida."));
    }
}
function quote(monthlyPrice, cycle, policy) {
    const discountPct = cycle.months >= 12 ? policy.annualDiscountPct : cycle.months >= 3 ? policy.quarterlyDiscountPct : 0;
    const subtotal = monthlyPrice * cycle.months;
    const discount = Math.round((subtotal * discountPct) / 100);
    return { months: cycle.months, monthlyPrice, subtotal, discountPct, discount, total: subtotal - discount };
}
function describeCycle(cycle) {
    if (cycle.kind === "MONTHLY")
        return "Mensal";
    if (cycle.kind === "QUARTERLY")
        return "Trimestral";
    if (cycle.kind === "ANNUAL")
        return "Anual";
    return cycle.months % 12 === 0
        ? `${cycle.months / 12} ano${cycle.months === 12 ? "" : "s"}`
        : `${cycle.months} ${cycle.months === 1 ? "mês" : "meses"}`;
}
//# sourceMappingURL=pricing.js.map