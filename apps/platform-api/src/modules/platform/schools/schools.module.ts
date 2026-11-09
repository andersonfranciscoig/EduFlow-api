import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import type { Clock, FileStorage, IdGenerator, PasswordHasher } from "../../../../../../libs/kernel/src/application/ports";
import { SHARED_TOKENS } from "../../../../../../libs/kernel/src/application/ports";
import type { Env } from "../../../config/env";
import { BcryptPasswordHasher } from "../../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { readKeyFile } from "../../../../../../libs/kernel/src/infrastructure/keys";
import { LocalFileStorage } from "../../../../../../libs/kernel/src/infrastructure/LocalFileStorage";
import { systemClock, uuidGenerator } from "../../../../../../libs/kernel/src/infrastructure/system";
import { BillingService } from "../billing/application/BillingService";
import { BillingModule } from "../billing/billing.module";
import { IdentityModule } from "../identity/identity.module";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import {
  type CodeGenerator,
  type PlanCatalog,
  SCHOOL_TOKENS as T,
  type SchoolSettings,
  type SchoolTokenService,
} from "./application/ports";
import { SchoolOnboarding } from "./application/SchoolOnboarding";
import { SchoolPayments } from "./application/SchoolPayments";
import type { SchoolRepository } from "./domain/SchoolRepository";
import { JwtSchoolTokenService, randomCodes } from "./infrastructure/adapters";
import { PrismaSchoolRepository } from "./infrastructure/PrismaSchoolRepository";
import { SchoolOwnerGuard } from "./presentation/http/school-auth";
import { SchoolOnboardingController, SchoolPortalController, SchoolsAdminController } from "./presentation/http/school.controllers";

/**
 * Contexto "Schools" do módulo Plataforma: colégios clientes, adesão,
 * subscrição e ciclo de pagamento. Fala com a faturação pela porta PlanCatalog.
 */
@Module({
  imports: [
    PlatformDatabaseModule,
    IdentityModule,
    BillingModule,
    // Tokens dos responsáveis dos colégios: par de chaves ES256 próprio.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        privateKey: readKeyFile(config.get("CUSTOMER_JWT_PRIVATE_KEY_FILE", { infer: true })),
        publicKey: readKeyFile(config.get("CUSTOMER_JWT_PUBLIC_KEY_FILE", { infer: true })),
        signOptions: { algorithm: "ES256" },
        verifyOptions: { algorithms: ["ES256"] },
      }),
    }),
  ],
  controllers: [SchoolOnboardingController, SchoolPortalController, SchoolsAdminController],
  providers: [
    { provide: SHARED_TOKENS.Clock, useValue: systemClock },
    { provide: SHARED_TOKENS.IdGenerator, useValue: uuidGenerator },
    { provide: SHARED_TOKENS.PasswordHasher, useFactory: () => new BcryptPasswordHasher() },
    {
      provide: SHARED_TOKENS.FileStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new LocalFileStorage(config.get("STORAGE_DIR", { infer: true })),
    },
    { provide: T.CodeGenerator, useValue: randomCodes },
    { provide: T.PlanCatalog, useExisting: BillingService },
    {
      provide: T.SchoolSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SchoolSettings => ({
        defaultPhoneCountryCode: config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
      }),
    },
    {
      provide: T.SchoolRepository,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaSchoolRepository(prisma),
    },
    {
      provide: T.SchoolTokenService,
      inject: [JwtService, ConfigService],
      useFactory: (jwt: JwtService, config: ConfigService<Env, true>) =>
        new JwtSchoolTokenService(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
    },
    {
      provide: SchoolOnboarding,
      inject: [
        T.SchoolRepository,
        T.PlanCatalog,
        SHARED_TOKENS.PasswordHasher,
        T.SchoolTokenService,
        SHARED_TOKENS.IdGenerator,
        T.CodeGenerator,
        SHARED_TOKENS.Clock,
        T.SchoolSettings,
      ],
      useFactory: (
        repo: SchoolRepository,
        catalog: PlanCatalog,
        hasher: PasswordHasher,
        tokens: SchoolTokenService,
        ids: IdGenerator,
        codes: CodeGenerator,
        clock: Clock,
        settings: SchoolSettings,
      ) => new SchoolOnboarding(repo, catalog, hasher, tokens, ids, codes, clock, settings),
    },
    {
      provide: SchoolPayments,
      inject: [T.SchoolRepository, T.PlanCatalog, SHARED_TOKENS.FileStorage, T.CodeGenerator, SHARED_TOKENS.Clock],
      useFactory: (repo: SchoolRepository, catalog: PlanCatalog, storage: FileStorage, codes: CodeGenerator, clock: Clock) =>
        new SchoolPayments(repo, catalog, storage, codes, clock),
    },
    SchoolOwnerGuard,
  ],
})
export class SchoolsModule {}
