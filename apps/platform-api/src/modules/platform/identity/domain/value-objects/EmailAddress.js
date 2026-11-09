"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailAddress = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../errors");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
class EmailAddress {
    value;
    constructor(value) {
        this.value = value;
    }
    static create(raw) {
        const normalized = raw.trim().toLowerCase();
        if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_EMAIL", "Este email não parece válido."));
        }
        return (0, Result_1.ok)(new EmailAddress(normalized));
    }
    equals(other) {
        return this.value === other.value;
    }
}
exports.EmailAddress = EmailAddress;
//# sourceMappingURL=EmailAddress.js.map