import { readFileSync } from "node:fs";
import path from "node:path";
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
import { DatabasePlacement } from "../databases/application/DatabasePlacement";
import { ACTIVATION_PLACEMENT, type ActivationPlacement, DatabasesModule } from "../databases/databases.module";
import { IdentityModule } from "../identity/identity.module";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import {
  type CodeGenerator,
  type LogoStorage,
  type PlanCatalog,
  SCHOOL_TOKENS as T,
  type SchoolDatabasePort,
  type SchoolNotifier,
  type SchoolSettings,
  type SchoolTokenService,
  type SupportTicketIssuer,
} from "./application/ports";
import { SchoolSupport } from "./application/SchoolSupport";
import { JwtSupportTicketIssuer } from "./infrastructure/support-tickets";
import { SchoolBranding } from "./application/SchoolBranding";
import { SchoolOnboarding } from "./application/SchoolOnboarding";
import { SchoolPayments } from "./application/SchoolPayments";
import type { SchoolRepository } from "./domain/SchoolRepository";
import { EmailSchoolNotifier, JwtSchoolTokenService, randomCodes } from "./infrastructure/adapters";
import type { Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import { EmailVerificationService } from "../verification/application/EmailVerificationService";
import { PLATFORM_MAILER, VerificationModule } from "../verification/verification.module";
import { EmailDeadlineSweeper } from "./infrastructure/email-deadline-sweeper";
import { LocalLogoStorage, UploadThingLogoStorage } from "./infrastructure/logo-storage";
import { EncryptedUploadThingFileStorage } from "./infrastructure/proof-storage";
import { readBackupKey } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { PrismaSchoolRepository } from "./infrastructure/PrismaSchoolRepository";
import { SchoolOwnerGuard } from "./presentation/http/school-auth";
import {
  SchoolLogoFilesController,
  SchoolOnboardingController,
  SchoolPortalController,
  SchoolsAdminController,
} from "./presentation/http/school.controllers";

/**
 * Contexto "Schools" do módulo Plataforma: colégios clientes, adesão,
 * subscrição e ciclo de pagamento. Fala com a faturação pela porta PlanCatalog.
 */
@Module({
  imports: [
    PlatformDatabaseModule,
    IdentityModule,
    BillingModule,
    DatabasesModule,
    VerificationModule,
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
  controllers: [SchoolOnboardingController, SchoolLogoFilesController, SchoolPortalController, SchoolsAdminController],
  providers: [
    { provide: SHARED_TOKENS.Clock, useValue: systemClock },
    { provide: SHARED_TOKENS.IdGenerator, useValue: uuidGenerator },
    { provide: SHARED_TOKENS.PasswordHasher, useFactory: () => new BcryptPasswordHasher() },
    {
      // comprovativos: UploadThing cifrado (os antigos, em disco, continuam a ler-se)
      provide: SHARED_TOKENS.FileStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): FileStorage => {
        const local = new LocalFileStorage(config.get("STORAGE_DIR", { infer: true }));
        if (config.get("FILE_STORAGE", { infer: true }) !== "uploadthing") return local;
        console.log("[platform-api] comprovativos: UploadThing (cifrados)");
        return new EncryptedUploadThingFileStorage(
          readFileSync(config.get("FILES_UPLOADTHING_TOKEN_FILE", { infer: true })!, "utf8"),
          readBackupKey(readFileSync(config.get("FILES_ENCRYPTION_KEY_FILE", { infer: true })!, "utf8")),
          config.get("FILES_UPLOADTHING_ACL", { infer: true }),
          local,
        );
      },
    },
    { provide: T.CodeGenerator, useValue: randomCodes },
    { provide: T.PlanCatalog, useExisting: BillingService },
    {
      provide: T.SchoolSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SchoolSettings => ({
        defaultPhoneCountryCode: config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
        portalUrlTemplate: config.get("PORTAL_URL_TEMPLATE", { infer: true }),
      }),
    },
    { provide: T.SchoolNotifier, inject: [PLATFORM_MAILER], useFactory: (mailer: Mailer) => new EmailSchoolNotifier(mailer) },
    {
      provide: T.SchoolRepository,
      inject: [PlatformPrismaService, ACTIVATION_PLACEMENT],
      useFactory: (prisma: PlatformPrismaService, placement: ActivationPlacement) => new PrismaSchoolRepository(prisma, placement),
    },
    { provide: T.SchoolDatabases, useExisting: DatabasePlacement },
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
        EmailVerificationService,
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
        verification: EmailVerificationService,
      ) => new SchoolOnboarding(repo, catalog, hasher, tokens, ids, codes, clock, settings, verification),
    },
    {
      provide: SchoolPayments,
      inject: [
        T.SchoolRepository,
        T.PlanCatalog,
        SHARED_TOKENS.FileStorage,
        T.CodeGenerator,
        SHARED_TOKENS.Clock,
        T.SchoolDatabases,
        T.SchoolNotifier,
        T.SchoolSettings,
      ],
      useFactory: (
        repo: SchoolRepository,
        catalog: PlanCatalog,
        storage: FileStorage,
        codes: CodeGenerator,
        clock: Clock,
        databases: SchoolDatabasePort,
        notifier: SchoolNotifier,
        settings: SchoolSettings,
      ) => new SchoolPayments(repo, catalog, storage, codes, clock, databases, notifier, settings),
    },
    {
      provide: T.LogoStorage,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): LogoStorage => {
        const tokenFile = config.get("LOGO_UPLOADTHING_TOKEN_FILE", { infer: true });
        const storage =
          config.get("LOGO_STORAGE", { infer: true }) === "uploadthing" && tokenFile
            ? new UploadThingLogoStorage(readFileSync(tokenFile, "utf8"))
            : new LocalLogoStorage(path.join(config.get("STORAGE_DIR", { infer: true }), "logos"), config.get("PUBLIC_API_URL", { infer: true }));
        console.log(`[platform-api] logótipos: ${storage.name}`);
        return storage;
      },
    },
    {
      provide: SchoolBranding,
      inject: [T.SchoolRepository, T.LogoStorage, SHARED_TOKENS.Clock],
      useFactory: (repo: SchoolRepository, storage: LogoStorage, clock: Clock) => new SchoolBranding(repo, storage, clock),
    },
    {
      provide: T.SupportTicketIssuer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new JwtSupportTicketIssuer(readKeyFile(config.get("SUPPORT_TICKET_PRIVATE_KEY_FILE", { infer: true }))),
    },
    {
      provide: SchoolSupport,
      inject: [T.SchoolRepository, T.SchoolDatabases, T.SupportTicketIssuer, T.SchoolSettings, SHARED_TOKENS.Clock],
      useFactory: (repo: SchoolRepository, databases: SchoolDatabasePort, tickets: SupportTicketIssuer, settings: SchoolSettings, clock: Clock) =>
        new SchoolSupport(repo, databases, tickets, settings, clock),
    },
    SchoolOwnerGuard,
    EmailDeadlineSweeper,
  ],
})
export class SchoolsModule {}
