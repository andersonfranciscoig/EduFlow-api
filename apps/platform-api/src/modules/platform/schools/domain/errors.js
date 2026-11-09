"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schoolError = void 0;
const DomainError_1 = require("../../../../../../../libs/kernel/src/domain/DomainError");
const schoolError = (code, message, meta) => new DomainError_1.DomainError(code, message, meta);
exports.schoolError = schoolError;
//# sourceMappingURL=errors.js.map