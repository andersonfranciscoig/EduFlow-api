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
exports.TenantController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const tenant_context_1 = require("./tenant-context");
let TenantController = class TenantController {
    async info(tenant) {
        const info = await tenant.db.tenantInfo.findUnique({ where: { id: 1 } });
        return {
            slug: tenant.entry.slug,
            name: info?.name ?? tenant.entry.schoolName,
            database: { name: tenant.entry.dbName, user: tenant.entry.dbUser, connected: !!info },
        };
    }
};
exports.TenantController = TenantController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({
        summary: "Identidade do colégio",
        description: "Lida da base de dados PRÓPRIA do colégio, com o utilizador PostgreSQL do próprio colégio.",
    }),
    __param(0, (0, tenant_context_1.CurrentTenant)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TenantController.prototype, "info", null);
exports.TenantController = TenantController = __decorate([
    (0, swagger_1.ApiTags)("Colégio"),
    (0, common_1.Controller)("v1/tenant"),
    (0, common_1.UseGuards)(tenant_context_1.TenantGuard),
    (0, swagger_1.ApiHeader)({ name: "X-Tenant", required: false, description: "Slug do colégio (em produção vem do subdomínio)" })
], TenantController);
//# sourceMappingURL=tenant.controller.js.map