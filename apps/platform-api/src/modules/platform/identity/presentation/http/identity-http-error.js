"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toHttpException = toHttpException;
const common_1 = require("@nestjs/common");
const STATUS_BY_CODE = {
    INVALID_IDENTIFIER: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    INVALID_EMAIL: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    INVALID_PHONE: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    INVALID_NAME: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    WEAK_PASSWORD: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
    ACCOUNT_ALREADY_EXISTS: common_1.HttpStatus.CONFLICT,
    INVALID_CREDENTIALS: common_1.HttpStatus.UNAUTHORIZED,
    ACCOUNT_LOCKED: common_1.HttpStatus.LOCKED,
    ACCOUNT_PENDING_APPROVAL: common_1.HttpStatus.FORBIDDEN,
    ACCOUNT_SUSPENDED: common_1.HttpStatus.FORBIDDEN,
    ACCOUNT_NOT_FOUND: common_1.HttpStatus.UNAUTHORIZED,
    MEMBER_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    CANNOT_MANAGE_SELF: common_1.HttpStatus.FORBIDDEN,
    ADMIN_REQUIRED: common_1.HttpStatus.FORBIDDEN,
    LAST_ADMIN: common_1.HttpStatus.CONFLICT,
    INVALID_STATE: common_1.HttpStatus.CONFLICT,
    INVALID_PERMISSION: common_1.HttpStatus.UNPROCESSABLE_ENTITY,
};
function toHttpException(error) {
    return new common_1.HttpException({ code: error.code, message: error.message, meta: error.meta ?? null }, STATUS_BY_CODE[error.code]);
}
//# sourceMappingURL=identity-http-error.js.map