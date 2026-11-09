"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchoolsModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const ports_1 = require("../../../../../../libs/kernel/src/application/ports");
const BcryptPasswordHasher_1 = require("../../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher");
const keys_1 = require("../../../../../../libs/kernel/src/infrastructure/keys");
const LocalFileStorage_1 = require("../../../../../../libs/kernel/src/infrastructure/LocalFileStorage");
const system_1 = require("../../../../../../libs/kernel/src/infrastructure/system");
const BillingService_1 = require("../billing/application/BillingService");
const billing_module_1 = require("../billing/billing.module");
const identity_module_1 = require("../identity/identity.module");
const platform_database_module_1 = require("../infrastructure/platform-database.module");
const platform_prisma_service_1 = require("../infrastructure/platform-prisma.service");
const ports_2 = require("./application/ports");
const SchoolOnboarding_1 = require("./application/SchoolOnboarding");
const SchoolPayments_1 = require("./application/SchoolPayments");
const adapters_1 = require("./infrastructure/adapters");
const PrismaSchoolRepository_1 = require("./infrastructure/PrismaSchoolRepository");
const school_auth_1 = require("./presentation/http/school-auth");
const school_controllers_1 = require("./presentation/http/school.controllers");
let SchoolsModule = class SchoolsModule {
};
exports.SchoolsModule = SchoolsModule;
exports.SchoolsModule = SchoolsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            platform_database_module_1.PlatformDatabaseModule,
            identity_module_1.IdentityModule,
            billing_module_1.BillingModule,
            jwt_1.JwtModule.registerAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    privateKey: (0, keys_1.readKeyFile)(config.get("CUSTOMER_JWT_PRIVATE_KEY_FILE", { infer: true })),
                    publicKey: (0, keys_1.readKeyFile)(config.get("CUSTOMER_JWT_PUBLIC_KEY_FILE", { infer: true })),
                    signOptions: { algorithm: "ES256" },
                    verifyOptions: { algorithms: ["ES256"] },
                }),
            }),
        ],
        controllers: [school_controllers_1.SchoolOnboardingController, school_controllers_1.SchoolPortalController, school_controllers_1.SchoolsAdminController],
        providers: [
            { provide: ports_1.SHARED_TOKENS.Clock, useValue: system_1.systemClock },
            { provide: ports_1.SHARED_TOKENS.IdGenerator, useValue: system_1.uuidGenerator },
            { provide: ports_1.SHARED_TOKENS.PasswordHasher, useFactory: () => new BcryptPasswordHasher_1.BcryptPasswordHasher() },
            {
                provide: ports_1.SHARED_TOKENS.FileStorage,
                inject: [config_1.ConfigService],
                useFactory: (config) => new LocalFileStorage_1.LocalFileStorage(config.get("STORAGE_DIR", { infer: true })),
            },
            { provide: ports_2.SCHOOL_TOKENS.CodeGenerator, useValue: adapters_1.randomCodes },
            { provide: ports_2.SCHOOL_TOKENS.PlanCatalog, useExisting: BillingService_1.BillingService },
            {
                provide: ports_2.SCHOOL_TOKENS.SchoolSettings,
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    defaultPhoneCountryCode: config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
                }),
            },
            {
                provide: ports_2.SCHOOL_TOKENS.SchoolRepository,
                inject: [platform_prisma_service_1.PlatformPrismaService],
                useFactory: (prisma) => new PrismaSchoolRepository_1.PrismaSchoolRepository(prisma),
            },
            {
                provide: ports_2.SCHOOL_TOKENS.SchoolTokenService,
                inject: [jwt_1.JwtService, config_1.ConfigService],
                useFactory: (jwt, config) => new adapters_1.JwtSchoolTokenService(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
            },
            {
                provide: SchoolOnboarding_1.SchoolOnboarding,
                inject: [
                    ports_2.SCHOOL_TOKENS.SchoolRepository,
                    ports_2.SCHOOL_TOKENS.PlanCatalog,
                    ports_1.SHARED_TOKENS.PasswordHasher,
                    ports_2.SCHOOL_TOKENS.SchoolTokenService,
                    ports_1.SHARED_TOKENS.IdGenerator,
                    ports_2.SCHOOL_TOKENS.CodeGenerator,
                    ports_1.SHARED_TOKENS.Clock,
                    ports_2.SCHOOL_TOKENS.SchoolSettings,
                ],
                useFactory: (repo, catalog, hasher, tokens, ids, codes, clock, settings) => new SchoolOnboarding_1.SchoolOnboarding(repo, catalog, hasher, tokens, ids, codes, clock, settings),
            },
            {
                provide: SchoolPayments_1.SchoolPayments,
                inject: [ports_2.SCHOOL_TOKENS.SchoolRepository, ports_2.SCHOOL_TOKENS.PlanCatalog, ports_1.SHARED_TOKENS.FileStorage, ports_2.SCHOOL_TOKENS.CodeGenerator, ports_1.SHARED_TOKENS.Clock],
                useFactory: (repo, catalog, storage, codes, clock) => new SchoolPayments_1.SchoolPayments(repo, catalog, storage, codes, clock),
            },
            school_auth_1.SchoolOwnerGuard,
        ],
    })
], SchoolsModule);
//# sourceMappingURL=schools.module.js.map