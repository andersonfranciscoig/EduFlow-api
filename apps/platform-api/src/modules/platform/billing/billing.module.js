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
exports.BillingModule = void 0;
const common_1 = require("@nestjs/common");
const system_1 = require("../../../../../../libs/kernel/src/infrastructure/system");
const identity_module_1 = require("../identity/identity.module");
const platform_database_module_1 = require("../infrastructure/platform-database.module");
const platform_prisma_service_1 = require("../infrastructure/platform-prisma.service");
const BillingService_1 = require("./application/BillingService");
const PrismaBillingRepository_1 = require("./infrastructure/PrismaBillingRepository");
const billing_controller_1 = require("./presentation/http/billing.controller");
let BillingModule = class BillingModule {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    async onModuleInit() {
        await this.repo.ensureDefaults();
    }
};
exports.BillingModule = BillingModule;
exports.BillingModule = BillingModule = __decorate([
    (0, common_1.Module)({
        imports: [platform_database_module_1.PlatformDatabaseModule, identity_module_1.IdentityModule],
        controllers: [billing_controller_1.PublicBillingController, billing_controller_1.BillingController],
        providers: [
            {
                provide: PrismaBillingRepository_1.PrismaBillingRepository,
                inject: [platform_prisma_service_1.PlatformPrismaService],
                useFactory: (prisma) => new PrismaBillingRepository_1.PrismaBillingRepository(prisma),
            },
            {
                provide: BillingService_1.BillingService,
                inject: [PrismaBillingRepository_1.PrismaBillingRepository],
                useFactory: (repo) => new BillingService_1.BillingService(repo, system_1.uuidGenerator),
            },
        ],
        exports: [BillingService_1.BillingService],
    }),
    __metadata("design:paramtypes", [PrismaBillingRepository_1.PrismaBillingRepository])
], BillingModule);
//# sourceMappingURL=billing.module.js.map