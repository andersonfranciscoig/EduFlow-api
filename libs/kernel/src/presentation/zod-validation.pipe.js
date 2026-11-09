"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZodValidationPipe = void 0;
const common_1 = require("@nestjs/common");
class ZodValidationPipe {
    schema;
    constructor(schema) {
        this.schema = schema;
    }
    transform(value) {
        const result = this.schema.safeParse(value);
        if (!result.success) {
            const first = result.error.issues[0];
            throw new common_1.BadRequestException({
                code: "VALIDATION_ERROR",
                message: first?.message ?? "Dados inválidos.",
                meta: { issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
            });
        }
        return result.data;
    }
}
exports.ZodValidationPipe = ZodValidationPipe;
//# sourceMappingURL=zod-validation.pipe.js.map