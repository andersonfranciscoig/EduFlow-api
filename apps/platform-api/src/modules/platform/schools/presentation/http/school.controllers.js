"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchoolsAdminController = exports.SchoolPortalController = exports.SchoolOnboardingController = void 0;
const common_1 = require("@nestjs/common");
const platform_express_1 = require("@nestjs/platform-express");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const domain_http_1 = require("../../../../../../../../libs/kernel/src/presentation/domain-http");
const openapi_1 = require("../../../../../../../../libs/kernel/src/presentation/openapi");
const zod_validation_pipe_1 = require("../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe");
const billing_schemas_1 = require("../../../billing/presentation/http/billing.schemas");
const staff_auth_1 = require("../../../identity/presentation/http/staff-auth");
const SchoolPayments_1 = require("../../application/SchoolPayments");
const SchoolOnboarding_1 = require("../../application/SchoolOnboarding");
const school_data_1 = require("../../domain/school-data");
const school_auth_1 = require("./school-auth");
const school_schemas_1 = require("./school.schemas");
const MINUTE = 60_000;
const uuid = new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.registerSchoolSchema.shape.subscription.shape.planId);
let SchoolOnboardingController = class SchoolOnboardingController {
    onboarding;
    constructor(onboarding) {
        this.onboarding = onboarding;
    }
    provinces() {
        return school_data_1.PROVINCES;
    }
    async checkEmail(body) {
        return (0, domain_http_1.unwrap)(await this.onboarding.checkEmail(body.email), school_schemas_1.SCHOOL_HTTP);
    }
    checkNif(body) {
        return this.onboarding.checkNif(body.nif);
    }
    async register(body) {
        const statuses = { ...billing_schemas_1.BILLING_HTTP, ...school_schemas_1.SCHOOL_HTTP };
        return (0, domain_http_1.unwrap)(await this.onboarding.register(body), statuses);
    }
    async signIn(body) {
        return (0, domain_http_1.unwrap)(await this.onboarding.signIn(body.email, body.password), school_schemas_1.SCHOOL_HTTP);
    }
};
exports.SchoolOnboardingController = SchoolOnboardingController;
__decorate([
    (0, common_1.Get)("provinces"),
    (0, swagger_1.ApiOperation)({ summary: "Províncias de Angola" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SchoolOnboardingController.prototype, "provinces", null);
__decorate([
    (0, common_1.Post)("check-email"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: MINUTE } }),
    (0, swagger_1.ApiOperation)({ summary: "Passo 1 — o email corporativo é válido e está livre?" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.emailCheckSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.emailCheckSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SchoolOnboardingController.prototype, "checkEmail", null);
__decorate([
    (0, common_1.Post)("check-nif"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: MINUTE } }),
    (0, swagger_1.ApiOperation)({ summary: "O NIF já está registado?" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.nifCheckSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.nifCheckSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SchoolOnboardingController.prototype, "checkNif", null);
__decorate([
    (0, common_1.Post)("register"),
    (0, throttler_1.Throttle)({ default: { limit: 5, ttl: 15 * MINUTE } }),
    (0, swagger_1.ApiOperation)({
        summary: "Registar colégio e pedir subscrição",
        description: "Cria o colégio (estado: por validar) e a encomenda da subscrição. Devolve um token do responsável.",
    }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.registerSchoolSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.registerSchoolSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SchoolOnboardingController.prototype, "register", null);
__decorate([
    (0, common_1.Post)("sign-in"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 5 * MINUTE } }),
    (0, swagger_1.ApiOperation)({ summary: "Login do responsável do colégio" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.signInSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.signInSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SchoolOnboardingController.prototype, "signIn", null);
exports.SchoolOnboardingController = SchoolOnboardingController = __decorate([
    (0, swagger_1.ApiTags)("Público · Registo de colégio"),
    (0, common_1.Controller)("v1/public/schools"),
    __metadata("design:paramtypes", [SchoolOnboarding_1.SchoolOnboarding])
], SchoolOnboardingController);
let SchoolPortalController = class SchoolPortalController {
    payments;
    constructor(payments) {
        this.payments = payments;
    }
    async me(schoolId) {
        return (0, domain_http_1.unwrap)(await this.payments.portalView(schoolId), school_schemas_1.SCHOOL_HTTP);
    }
    async proof(schoolId, body, file) {
        if (!file)
            throw new common_1.BadRequestException({ code: "INVALID_PROOF", message: "Anexe o comprovativo." });
        return (0, domain_http_1.unwrap)(await this.payments.submitTransferProof(schoolId, {
            transactionNumber: body.transactionNumber,
            file: { fileName: file.originalname.slice(0, 120), mimeType: file.mimetype, content: file.buffer },
        }), school_schemas_1.SCHOOL_HTTP);
    }
    async simulate(schoolId) {
        return (0, domain_http_1.unwrap)(await this.payments.simulateReferencePayment(schoolId), school_schemas_1.SCHOOL_HTTP);
    }
};
exports.SchoolPortalController = SchoolPortalController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: "Estado do colégio, subscrição, instruções de pagamento e histórico" }),
    __param(0, (0, school_auth_1.CurrentSchoolId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SchoolPortalController.prototype, "me", null);
__decorate([
    (0, common_1.Post)("payment/proof"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 15 * MINUTE } }),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)("proof", { limits: { fileSize: SchoolPayments_1.MAX_PROOF_BYTES, files: 1 } })),
    (0, swagger_1.ApiConsumes)("multipart/form-data"),
    (0, swagger_1.ApiBody)({
        schema: {
            type: "object",
            required: ["transactionNumber", "proof"],
            properties: { transactionNumber: { type: "string" }, proof: { type: "string", format: "binary" } },
        },
    }),
    (0, swagger_1.ApiOperation)({ summary: "Enviar comprovativo de transferência", description: "PDF ou imagem até 5 MB. Validação manual pela equipa." }),
    __param(0, (0, school_auth_1.CurrentSchoolId)()),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.proofSchema))),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchoolPortalController.prototype, "proof", null);
__decorate([
    (0, common_1.Post)("payment/simulate-reference"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({
        summary: "SIMULAÇÃO — pagar a referência",
        description: "Ambiente de teste: simula a confirmação do gateway de pagamentos por referência.",
    }),
    __param(0, (0, school_auth_1.CurrentSchoolId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SchoolPortalController.prototype, "simulate", null);
exports.SchoolPortalController = SchoolPortalController = __decorate([
    (0, swagger_1.ApiTags)("Portal do colégio"),
    (0, common_1.Controller)("v1/schools/me"),
    (0, school_auth_1.SchoolOwnerAuth)(),
    __metadata("design:paramtypes", [SchoolPayments_1.SchoolPayments])
], SchoolPortalController);
let SchoolsAdminController = class SchoolsAdminController {
    payments;
    constructor(payments) {
        this.payments = payments;
    }
    list(query) {
        return this.payments.list(query.status);
    }
    async detail(id) {
        return (0, domain_http_1.unwrap)(await this.payments.detail(id), school_schemas_1.SCHOOL_HTTP);
    }
    async approve(id, body, staff) {
        return (0, domain_http_1.unwrap)(await this.payments.approve(id, staff.id, body), school_schemas_1.SCHOOL_HTTP);
    }
    async reject(id, body, staff) {
        return (0, domain_http_1.unwrap)(await this.payments.reject(id, staff.id, body.reason), school_schemas_1.SCHOOL_HTTP);
    }
    async paymentMethod(id, body, staff) {
        return (0, domain_http_1.unwrap)(await this.payments.changePaymentMethod(id, staff.id, body), school_schemas_1.SCHOOL_HTTP);
    }
    async confirm(id, staff) {
        return (0, domain_http_1.unwrap)(await this.payments.confirmTransfer(id, staff.id), school_schemas_1.SCHOOL_HTTP);
    }
    async rejectProof(id, body, staff) {
        return (0, domain_http_1.unwrap)(await this.payments.rejectProof(id, staff.id, body.reason), school_schemas_1.SCHOOL_HTTP);
    }
    async proof(id, res) {
        const file = (0, domain_http_1.unwrap)(await this.payments.proofFile(id), school_schemas_1.SCHOOL_HTTP);
        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(file.content);
    }
};
exports.SchoolsAdminController = SchoolsAdminController;
__decorate([
    (0, common_1.Get)(),
    (0, staff_auth_1.StaffAuth)("schools.view"),
    (0, swagger_1.ApiOperation)({ summary: "Listar colégios (com contagens por estado)" }),
    __param(0, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.schoolStatusQuery))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SchoolsAdminController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(":id"),
    (0, staff_auth_1.StaffAuth)("schools.view"),
    (0, swagger_1.ApiOperation)({ summary: "Detalhe do colégio, subscrição e histórico" }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "detail", null);
__decorate([
    (0, common_1.Post)(":id/approve"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("schools.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Validar pedido e definir a forma de pagamento" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.paymentMethodSchema) }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.paymentMethodSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "approve", null);
__decorate([
    (0, common_1.Post)(":id/reject"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("schools.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Rejeitar pedido" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.reasonSchema) }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.reasonSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "reject", null);
__decorate([
    (0, common_1.Post)(":id/payment-method"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Alterar a forma de pagamento (ex.: referência expirada)" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.paymentMethodSchema) }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.paymentMethodSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "paymentMethod", null);
__decorate([
    (0, common_1.Post)(":id/payment/confirm"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Confirmar transferência (após verificar com o banco)" }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "confirm", null);
__decorate([
    (0, common_1.Post)(":id/payment/reject-proof"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Rejeitar comprovativo" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(school_schemas_1.reasonSchema) }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(school_schemas_1.reasonSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "rejectProof", null);
__decorate([
    (0, common_1.Get)(":id/payment/proof"),
    (0, staff_auth_1.StaffAuth)("billing.view"),
    (0, swagger_1.ApiOperation)({ summary: "Descarregar comprovativo" }),
    __param(0, (0, common_1.Param)("id", uuid)),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], SchoolsAdminController.prototype, "proof", null);
exports.SchoolsAdminController = SchoolsAdminController = __decorate([
    (0, swagger_1.ApiTags)("Plataforma · Colégios"),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)("v1/platform/schools"),
    __metadata("design:paramtypes", [SchoolPayments_1.SchoolPayments])
], SchoolsAdminController);
//# sourceMappingURL=school.controllers.js.map