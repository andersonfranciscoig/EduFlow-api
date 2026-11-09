"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.domainToHttp = domainToHttp;
exports.unwrap = unwrap;
const common_1 = require("@nestjs/common");
function domainToHttp(error, statusByCode) {
    return new common_1.HttpException({ code: error.code, message: error.message, meta: error.meta ?? null }, statusByCode[error.code] ?? common_1.HttpStatus.UNPROCESSABLE_ENTITY);
}
function unwrap(result, statusByCode) {
    if (!result.ok)
        throw domainToHttp(result.error, statusByCode);
    return result.value;
}
//# sourceMappingURL=domain-http.js.map