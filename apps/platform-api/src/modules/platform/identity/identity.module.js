"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdentityModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const keys_1 = require("../../../../../../libs/kernel/src/infrastructure/keys");
const system_1 = require("../../../../../../libs/kernel/src/infrastructure/system");
const platform_database_module_1 = require("../infrastructure/platform-database.module");
const platform_prisma_service_1 = require("../infrastructure/platform-prisma.service");
const ports_1 = require("./application/ports");
const AuthenticateStaffMember_1 = require("./application/use-cases/AuthenticateStaffMember");
const GetStaffProfile_1 = require("./application/use-cases/GetStaffProfile");
const IdentifyStaffMember_1 = require("./application/use-cases/IdentifyStaffMember");
const RegisterStaffMember_1 = require("./application/use-cases/RegisterStaffMember");
const ManageStaffMember_1 = require("./application/use-cases/staff/ManageStaffMember");
const QueryStaff_1 = require("./application/use-cases/staff/QueryStaff");
const ResolveStaffAccess_1 = require("./application/use-cases/staff/ResolveStaffAccess");
const BcryptPasswordHasher_1 = require("../../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher");
const JwtAccessTokenService_1 = require("./infrastructure/JwtAccessTokenService");
const PrismaStaffActivityQuery_1 = require("./infrastructure/PrismaStaffActivityQuery");
const PrismaStaffMemberRepository_1 = require("./infrastructure/PrismaStaffMemberRepository");
const auth_controller_1 = require("./presentation/http/auth.controller");
const staff_auth_1 = require("./presentation/http/staff-auth");
const staff_controller_1 = require("./presentation/http/staff.controller");
let IdentityModule = class IdentityModule {
};
exports.IdentityModule = IdentityModule;
exports.IdentityModule = IdentityModule = __decorate([
    (0, common_1.Module)({
        imports: [
            platform_database_module_1.PlatformDatabaseModule,
            jwt_1.JwtModule.registerAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    privateKey: (0, keys_1.readKeyFile)(config.get("STAFF_JWT_PRIVATE_KEY_FILE", { infer: true })),
                    publicKey: (0, keys_1.readKeyFile)(config.get("STAFF_JWT_PUBLIC_KEY_FILE", { infer: true })),
                    signOptions: { algorithm: "ES256" },
                    verifyOptions: { algorithms: ["ES256"] },
                }),
            }),
        ],
        controllers: [auth_controller_1.AuthController, staff_controller_1.StaffController],
        providers: [
            { provide: ports_1.IDENTITY_TOKENS.Clock, useValue: system_1.systemClock },
            { provide: ports_1.IDENTITY_TOKENS.IdGenerator, useValue: system_1.uuidGenerator },
            { provide: ports_1.IDENTITY_TOKENS.PasswordHasher, useFactory: () => new BcryptPasswordHasher_1.BcryptPasswordHasher() },
            {
                provide: ports_1.IDENTITY_TOKENS.IdentitySettings,
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    defaultPhoneCountryCode: config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
                }),
            },
            {
                provide: ports_1.IDENTITY_TOKENS.StaffMemberRepository,
                inject: [platform_prisma_service_1.PlatformPrismaService],
                useFactory: (prisma) => new PrismaStaffMemberRepository_1.PrismaStaffMemberRepository(prisma),
            },
            {
                provide: ports_1.IDENTITY_TOKENS.AccessTokenService,
                inject: [jwt_1.JwtService, config_1.ConfigService],
                useFactory: (jwt, config) => new JwtAccessTokenService_1.JwtAccessTokenService(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
            },
            {
                provide: IdentifyStaffMember_1.IdentifyStaffMember,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository, ports_1.IDENTITY_TOKENS.IdentitySettings],
                useFactory: (repo, settings) => new IdentifyStaffMember_1.IdentifyStaffMember(repo, settings),
            },
            {
                provide: RegisterStaffMember_1.RegisterStaffMember,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository, ports_1.IDENTITY_TOKENS.PasswordHasher, ports_1.IDENTITY_TOKENS.IdGenerator, ports_1.IDENTITY_TOKENS.Clock, ports_1.IDENTITY_TOKENS.IdentitySettings],
                useFactory: (repo, hasher, ids, clock, settings) => new RegisterStaffMember_1.RegisterStaffMember(repo, hasher, ids, clock, settings),
            },
            {
                provide: AuthenticateStaffMember_1.AuthenticateStaffMember,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository, ports_1.IDENTITY_TOKENS.PasswordHasher, ports_1.IDENTITY_TOKENS.Clock, ports_1.IDENTITY_TOKENS.IdentitySettings],
                useFactory: (repo, hasher, clock, settings) => new AuthenticateStaffMember_1.AuthenticateStaffMember(repo, hasher, clock, settings),
            },
            {
                provide: GetStaffProfile_1.GetStaffProfile,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository],
                useFactory: (repo) => new GetStaffProfile_1.GetStaffProfile(repo),
            },
            {
                provide: ports_1.IDENTITY_TOKENS.StaffActivityQuery,
                inject: [platform_prisma_service_1.PlatformPrismaService],
                useFactory: (prisma) => new PrismaStaffActivityQuery_1.PrismaStaffActivityQuery(prisma),
            },
            ...[ResolveStaffAccess_1.ResolveStaffAccess, QueryStaff_1.ListStaffMembers, QueryStaff_1.GetStaffMember].map((UseCase) => ({
                provide: UseCase,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository],
                useFactory: (repo) => new UseCase(repo),
            })),
            {
                provide: QueryStaff_1.GetStaffActivity,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository, ports_1.IDENTITY_TOKENS.StaffActivityQuery],
                useFactory: (repo, activity) => new QueryStaff_1.GetStaffActivity(repo, activity),
            },
            ...[ManageStaffMember_1.ActivateStaffMember, ManageStaffMember_1.SuspendStaffMember, ManageStaffMember_1.ChangeStaffRole, ManageStaffMember_1.SetStaffPermissions].map((Command) => ({
                provide: Command,
                inject: [ports_1.IDENTITY_TOKENS.StaffMemberRepository, ports_1.IDENTITY_TOKENS.Clock],
                useFactory: (repo, clock) => new Command(repo, clock),
            })),
            staff_auth_1.StaffAuthGuard,
            staff_auth_1.StaffPermissionsGuard,
        ],
        exports: [ports_1.IDENTITY_TOKENS.AccessTokenService, ResolveStaffAccess_1.ResolveStaffAccess, staff_auth_1.StaffAuthGuard, staff_auth_1.StaffPermissionsGuard],
    })
], IdentityModule);
//# sourceMappingURL=identity.module.js.map