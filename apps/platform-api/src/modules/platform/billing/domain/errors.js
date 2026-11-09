"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingError = void 0;
const DomainError_1 = require("../../../../../../../libs/kernel/src/domain/DomainError");
const billingError = (code, message, meta) => new DomainError_1.DomainError(code, message, meta);
exports.billingError = billingError;
//# sourceMappingURL=errors.js.map