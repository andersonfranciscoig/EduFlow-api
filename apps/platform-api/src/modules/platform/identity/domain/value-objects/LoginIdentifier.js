"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectIdentifierKind = detectIdentifierKind;
exports.parseLoginIdentifier = parseLoginIdentifier;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../errors");
const EmailAddress_1 = require("./EmailAddress");
const PhoneNumber_1 = require("./PhoneNumber");
function detectIdentifierKind(raw) {
    const value = raw.trim();
    if (!value)
        return null;
    if (value.includes("@") || /[a-z]/i.test(value))
        return "email";
    if (/^[+\d\s().-]+$/.test(value))
        return "phone";
    return null;
}
function parseLoginIdentifier(raw, defaultCountryCode) {
    const kind = detectIdentifierKind(raw);
    if (kind === "email") {
        const email = EmailAddress_1.EmailAddress.create(raw);
        return email.ok ? (0, Result_1.ok)({ kind, email: email.value, value: email.value.value }) : email;
    }
    if (kind === "phone") {
        const phone = PhoneNumber_1.PhoneNumber.create(raw, defaultCountryCode);
        return phone.ok ? (0, Result_1.ok)({ kind, phone: phone.value, value: phone.value.value }) : phone;
    }
    return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_IDENTIFIER", "Introduza um email ou número de telefone."));
}
//# sourceMappingURL=LoginIdentifier.js.map