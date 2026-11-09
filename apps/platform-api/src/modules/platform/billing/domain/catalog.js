"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePlan = validatePlan;
exports.validateSettings = validateSettings;
exports.normalizeIban = normalizeIban;
exports.validateBankAccount = validateBankAccount;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("./errors");
function validatePlan(input) {
    const name = input.name.trim();
    const code = input.code.trim().toUpperCase();
    if (name.length < 2)
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_PLAN", "O plano precisa de um nome."));
    if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_PLAN", "Código inválido (2–20 letras, números, - ou _)."));
    }
    if (!Number.isInteger(input.monthlyPrice) || input.monthlyPrice <= 0) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_PLAN", "O preço mensal tem de ser um valor positivo."));
    }
    if (input.maxStudents !== null && (!Number.isInteger(input.maxStudents) || input.maxStudents < 1)) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_PLAN", "O limite de alunos tem de ser um número positivo."));
    }
    return (0, Result_1.ok)({
        ...input,
        name,
        code,
        description: input.description.trim(),
        features: input.features.map((f) => f.trim()).filter(Boolean),
    });
}
function validateSettings(input) {
    const pct = (v) => Number.isInteger(v) && v >= 0 && v <= 90;
    if (!pct(input.quarterlyDiscountPct) || !pct(input.annualDiscountPct)) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_SETTINGS", "Os descontos têm de estar entre 0% e 90%."));
    }
    if (!/^\d{5}$/.test(input.referenceEntity)) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_SETTINGS", "A entidade tem de ter 5 dígitos."));
    }
    if (!Number.isInteger(input.referenceValidityDays) || input.referenceValidityDays < 1 || input.referenceValidityDays > 30) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_SETTINGS", "A validade da referência tem de estar entre 1 e 30 dias."));
    }
    return (0, Result_1.ok)({
        ...input,
        referenceProvider: input.referenceProvider.trim() || "Multicaixa",
        transferInstructions: input.transferInstructions?.trim() || null,
    });
}
function normalizeIban(raw) {
    const iban = raw.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban))
        return null;
    if (iban.startsWith("AO") && !/^AO\d{23}$/.test(iban))
        return null;
    const rearranged = iban.slice(4) + iban.slice(0, 4);
    const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let remainder = 0;
    for (const digit of numeric)
        remainder = (remainder * 10 + Number(digit)) % 97;
    return remainder === 1 ? iban : null;
}
function validateBankAccount(input) {
    const bankName = input.bankName.trim();
    const holder = input.holder.trim();
    if (bankName.length < 2)
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_BANK_ACCOUNT", "Indique o nome do banco."));
    if (holder.length < 3)
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_BANK_ACCOUNT", "Indique o titular da conta."));
    const iban = normalizeIban(input.iban);
    if (!iban)
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_BANK_ACCOUNT", "IBAN inválido. Confira os dígitos."));
    const swift = input.swift?.replace(/\s+/g, "").toUpperCase() || null;
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) {
        return (0, Result_1.fail)((0, errors_1.billingError)("INVALID_BANK_ACCOUNT", "Código SWIFT/BIC inválido."));
    }
    return (0, Result_1.ok)({ bankName, holder, iban, swift, active: input.active });
}
//# sourceMappingURL=catalog.js.map