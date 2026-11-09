"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FullName = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../errors");
class FullName {
    value;
    constructor(value) {
        this.value = value;
    }
    static create(raw) {
        const normalized = raw.trim().replace(/\s+/g, " ");
        if (normalized.length < 3 || normalized.length > 120 || !/\p{L}/u.test(normalized)) {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_NAME", "Escreva o seu nome (pelo menos 3 letras)."));
        }
        return (0, Result_1.ok)(new FullName(normalized));
    }
    get firstName() {
        return this.value.split(" ")[0];
    }
}
exports.FullName = FullName;
//# sourceMappingURL=FullName.js.map