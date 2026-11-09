"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.identityError = void 0;
const DomainError_1 = require("../../../../../../../libs/kernel/src/domain/DomainError");
const identityError = (code, message, meta) => new DomainError_1.DomainError(code, message, meta);
exports.identityError = identityError;
//# sourceMappingURL=errors.js.map