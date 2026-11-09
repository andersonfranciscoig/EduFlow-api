"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhoneNumber = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../errors");
class PhoneNumber {
    value;
    constructor(value) {
        this.value = value;
    }
    static create(raw, defaultCountryCode) {
        const compact = raw.trim().replace(/[\s().-]/g, "");
        let digits;
        if (compact.startsWith("+"))
            digits = compact.slice(1);
        else if (compact.startsWith("00"))
            digits = compact.slice(2);
        else
            digits = `${defaultCountryCode}${compact.replace(/^0+/, "")}`;
        if (!/^[1-9]\d{7,14}$/.test(digits)) {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_PHONE", "Este número de telefone não parece válido."));
        }
        return (0, Result_1.ok)(new PhoneNumber(`+${digits}`));
    }
    equals(other) {
        return this.value === other.value;
    }
}
exports.PhoneNumber = PhoneNumber;
//# sourceMappingURL=PhoneNumber.js.map