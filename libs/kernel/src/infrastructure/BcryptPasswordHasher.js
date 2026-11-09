"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BcryptPasswordHasher = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
class BcryptPasswordHasher {
    cost;
    constructor(cost = 12) {
        this.cost = cost;
    }
    hash(plain) {
        return bcryptjs_1.default.hash(plain, this.cost);
    }
    verify(plain, hash) {
        return bcryptjs_1.default.compare(plain, hash);
    }
}
exports.BcryptPasswordHasher = BcryptPasswordHasher;
//# sourceMappingURL=BcryptPasswordHasher.js.map