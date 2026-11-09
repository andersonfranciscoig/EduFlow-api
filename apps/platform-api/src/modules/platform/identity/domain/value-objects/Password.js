"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlainPassword = exports.passwordRules = void 0;
exports.passwordStrength = passwordStrength;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../errors");
exports.passwordRules = [
    { id: "length", label: "Pelo menos 8 caracteres", test: (p) => p.length >= 8 },
    { id: "letter", label: "Uma letra", test: (p) => /\p{L}/u.test(p) },
    { id: "number", label: "Um número", test: (p) => /\d/.test(p) },
    { id: "mixed", label: "Maiúsculas e minúsculas", test: (p) => /\p{Lu}/u.test(p) && /\p{Ll}/u.test(p) },
];
const REQUIRED_RULES = new Set(["length", "letter", "number"]);
function passwordStrength(password) {
    if (!password)
        return 0;
    let score = exports.passwordRules.filter((r) => r.test(password)).length;
    if (password.length >= 12 && /[^\p{L}\d]/u.test(password))
        score = Math.min(4, score + 1);
    if (password.length < 8)
        score = Math.min(score, 1);
    return score;
}
class PlainPassword {
    value;
    constructor(value) {
        this.value = value;
    }
    static create(raw) {
        const broken = exports.passwordRules.filter((r) => REQUIRED_RULES.has(r.id) && !r.test(raw));
        if (broken.length > 0 || raw.length > 128) {
            return (0, Result_1.fail)((0, errors_1.identityError)("WEAK_PASSWORD", "A senha precisa de 8+ caracteres, com letras e números."));
        }
        return (0, Result_1.ok)(new PlainPassword(raw));
    }
}
exports.PlainPassword = PlainPassword;
//# sourceMappingURL=Password.js.map