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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const env_1 = require("./config/env");
const tenant_connections_1 = require("./tenancy/tenant-connections");
const tenant_context_1 = require("./tenancy/tenant-context");
const tenant_controller_1 = require("./tenancy/tenant.controller");
const tenant_directory_1 = require("./tenancy/tenant-directory");
let HealthController = class HealthController {
    check() {
        return { status: "ok", service: "school-api", time: new Date().toISOString() };
    }
};
__decorate([
    (0, common_1.Get)(),
    (0, throttler_1.SkipThrottle)(),
    (0, swagger_1.ApiOperation)({ summary: "Estado do serviço" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], HealthController.prototype, "check", null);
HealthController = __decorate([
    (0, swagger_1.ApiTags)("Sistema"),
    (0, common_1.Controller)("health")
], HealthController);
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                cache: true,
                envFilePath: "apps/school-api/.env",
                ignoreEnvFile: process.env.NODE_ENV === "production",
                validate: env_1.validateEnv,
            }),
            throttler_1.ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
        ],
        controllers: [HealthController, tenant_controller_1.TenantController],
        providers: [tenant_directory_1.TenantDirectory, tenant_connections_1.TenantConnections, tenant_context_1.TenantGuard, { provide: core_1.APP_GUARD, useClass: throttler_1.ThrottlerGuard }],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map