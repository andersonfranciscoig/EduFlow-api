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
exports.BillingController = exports.PublicBillingController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const domain_http_1 = require("../../../../../../../../libs/kernel/src/presentation/domain-http");
const openapi_1 = require("../../../../../../../../libs/kernel/src/presentation/openapi");
const zod_validation_pipe_1 = require("../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe");
const staff_auth_1 = require("../../../identity/presentation/http/staff-auth");
const BillingService_1 = require("../../application/BillingService");
const billing_schemas_1 = require("./billing.schemas");
const id = new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.uuidSchema);
let PublicBillingController = class PublicBillingController {
    billing;
    constructor(billing) {
        this.billing = billing;
    }
    plans() {
        return this.billing.publicCatalog();
    }
    async quote(body) {
        return (0, domain_http_1.unwrap)(await this.billing.quote(body.planId, body.cycle), billing_schemas_1.BILLING_HTTP);
    }
};
exports.PublicBillingController = PublicBillingController;
__decorate([
    (0, common_1.Get)("plans"),
    (0, swagger_1.ApiOperation)({ summary: "Planos disponíveis e descontos por periodicidade" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PublicBillingController.prototype, "plans", null);
__decorate([
    (0, common_1.Post)("quote"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: "Calcular o valor de uma subscrição", description: "Plano + periodicidade (incl. personalizada)." }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.quoteSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.quoteSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PublicBillingController.prototype, "quote", null);
exports.PublicBillingController = PublicBillingController = __decorate([
    (0, swagger_1.ApiTags)("Público · Planos"),
    (0, common_1.Controller)("v1/public/billing"),
    __metadata("design:paramtypes", [BillingService_1.BillingService])
], PublicBillingController);
let BillingController = class BillingController {
    billing;
    constructor(billing) {
        this.billing = billing;
    }
    settings() {
        return this.billing.getSettings();
    }
    async updateSettings(body) {
        return (0, domain_http_1.unwrap)(await this.billing.updateSettings(body), billing_schemas_1.BILLING_HTTP);
    }
    plans() {
        return this.billing.listPlans();
    }
    async createPlan(body) {
        return (0, domain_http_1.unwrap)(await this.billing.createPlan(body), billing_schemas_1.BILLING_HTTP);
    }
    async updatePlan(planId, body) {
        return (0, domain_http_1.unwrap)(await this.billing.updatePlan(planId, body), billing_schemas_1.BILLING_HTTP);
    }
    bankAccounts() {
        return this.billing.listBankAccounts();
    }
    async createBankAccount(body) {
        return (0, domain_http_1.unwrap)(await this.billing.createBankAccount(body), billing_schemas_1.BILLING_HTTP);
    }
    async updateBankAccount(accountId, body) {
        return (0, domain_http_1.unwrap)(await this.billing.updateBankAccount(accountId, body), billing_schemas_1.BILLING_HTTP);
    }
    async deleteBankAccount(accountId) {
        (0, domain_http_1.unwrap)(await this.billing.deleteBankAccount(accountId), billing_schemas_1.BILLING_HTTP);
    }
};
exports.BillingController = BillingController;
__decorate([
    (0, common_1.Get)("settings"),
    (0, staff_auth_1.StaffAuth)("billing.view"),
    (0, swagger_1.ApiOperation)({ summary: "Definições de faturação" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "settings", null);
__decorate([
    (0, common_1.Put)("settings"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Atualizar definições (descontos, referência, transferência)" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.settingsSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.settingsSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "updateSettings", null);
__decorate([
    (0, common_1.Get)("plans"),
    (0, staff_auth_1.StaffAuth)("billing.view"),
    (0, swagger_1.ApiOperation)({ summary: "Todos os planos (incl. inativos)" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "plans", null);
__decorate([
    (0, common_1.Post)("plans"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Criar plano" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.planSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.planSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "createPlan", null);
__decorate([
    (0, common_1.Put)("plans/:id"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Atualizar plano" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.planSchema) }),
    __param(0, (0, common_1.Param)("id", id)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.planSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "updatePlan", null);
__decorate([
    (0, common_1.Get)("bank-accounts"),
    (0, staff_auth_1.StaffAuth)("billing.view"),
    (0, swagger_1.ApiOperation)({ summary: "Contas bancárias para transferências" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "bankAccounts", null);
__decorate([
    (0, common_1.Post)("bank-accounts"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Adicionar conta bancária", description: "O IBAN é validado (mod-97)." }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.bankAccountSchema) }),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.bankAccountSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "createBankAccount", null);
__decorate([
    (0, common_1.Put)("bank-accounts/:id"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Atualizar conta bancária" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(billing_schemas_1.bankAccountSchema) }),
    __param(0, (0, common_1.Param)("id", id)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(billing_schemas_1.bankAccountSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "updateBankAccount", null);
__decorate([
    (0, common_1.Delete)("bank-accounts/:id"),
    (0, staff_auth_1.StaffAuth)("billing.manage"),
    (0, common_1.HttpCode)(common_1.HttpStatus.NO_CONTENT),
    (0, swagger_1.ApiOperation)({ summary: "Remover conta bancária" }),
    __param(0, (0, common_1.Param)("id", id)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BillingController.prototype, "deleteBankAccount", null);
exports.BillingController = BillingController = __decorate([
    (0, swagger_1.ApiTags)("Plataforma · Faturação"),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)("v1/platform/billing"),
    __metadata("design:paramtypes", [BillingService_1.BillingService])
], BillingController);
//# sourceMappingURL=billing.controller.js.map