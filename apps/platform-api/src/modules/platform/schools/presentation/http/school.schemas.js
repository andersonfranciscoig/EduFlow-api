"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schoolStatusQuery = exports.reasonSchema = exports.paymentMethodSchema = exports.proofSchema = exports.signInSchema = exports.registerSchoolSchema = exports.nifCheckSchema = exports.emailCheckSchema = exports.SCHOOL_HTTP = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const billing_schemas_1 = require("../../../billing/presentation/http/billing.schemas");
const school_data_1 = require("../../domain/school-data");
exports.SCHOOL_HTTP = {
    EMAIL_TAKEN: common_1.HttpStatus.CONFLICT,
    NIF_TAKEN: common_1.HttpStatus.CONFLICT,
    INVALID_CREDENTIALS: common_1.HttpStatus.UNAUTHORIZED,
    SCHOOL_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    PROOF_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    REFERENCE_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    INVALID_STATE: common_1.HttpStatus.CONFLICT,
    REFERENCE_EXPIRED: common_1.HttpStatus.GONE,
};
const text = (message, max) => zod_1.z.string({ error: message }).trim().min(1, message).max(max);
exports.emailCheckSchema = zod_1.z.object({ email: text("Indique o email.", 254) }).meta({ title: "EmailCheck" });
exports.nifCheckSchema = zod_1.z.object({ nif: text("Indique o NIF.", 20) }).meta({ title: "NifCheck" });
exports.registerSchoolSchema = zod_1.z
    .object({
    owner: zod_1.z.object({
        name: text("Indique o nome do responsável.", 120),
        email: text("Indique o email.", 254).meta({ example: "direcao@colegioexemplo.ao" }),
        password: zod_1.z.string({ error: "Indique a senha." }).max(128),
    }),
    school: zod_1.z.object({
        name: text("Indique o nome do colégio.", 160).meta({ example: "Colégio Exemplo" }),
        nif: text("Indique o NIF.", 20).meta({ example: "5417123456" }),
        phone: text("Indique o telefone.", 30).meta({ example: "923 456 789" }),
        province: zod_1.z.enum(school_data_1.PROVINCES, { error: "Escolha a província." }),
        municipality: text("Indique o município.", 80),
        address: text("Indique a morada.", 200),
    }),
    subscription: zod_1.z.object({ planId: zod_1.z.uuid({ error: "Escolha um plano." }), cycle: billing_schemas_1.cycleSchema }),
})
    .meta({ title: "RegisterSchool" });
exports.signInSchema = zod_1.z
    .object({ email: text("Indique o email.", 254), password: zod_1.z.string().min(1, "Indique a senha.").max(128) })
    .meta({ title: "SchoolSignIn" });
exports.proofSchema = zod_1.z.object({
    transactionNumber: text("Indique o número da transação.", 60),
});
exports.paymentMethodSchema = zod_1.z
    .object({
    method: zod_1.z.enum(["REFERENCE", "TRANSFER"], { error: "Escolha a forma de pagamento." }),
    bankAccountId: zod_1.z.uuid().optional().meta({ description: "Obrigatório para TRANSFER" }),
})
    .meta({ title: "PaymentMethodChoice" });
exports.reasonSchema = zod_1.z.object({ reason: text("Indique o motivo.", 500) }).meta({ title: "Reason" });
exports.schoolStatusQuery = zod_1.z.object({
    status: zod_1.z.enum(["PENDING_REVIEW", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW", "ACTIVE", "REJECTED"]).optional(),
});
//# sourceMappingURL=school.schemas.js.map