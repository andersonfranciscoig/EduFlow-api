"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainError = void 0;
class DomainError {
    code;
    message;
    meta;
    constructor(code, message, meta) {
        this.code = code;
        this.message = message;
        this.meta = meta;
    }
}
exports.DomainError = DomainError;
//# sourceMappingURL=DomainError.js.map