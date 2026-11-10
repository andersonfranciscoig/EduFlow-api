import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import type { Env } from "../../../config/env";
import { readKeyFile } from "../../../../../../libs/kernel/src/infrastructure/keys";
import { SecretBox } from "../../../../../../libs/kernel/src/infrastructure/secret-box";
import { systemClock, uuidGenerator } from "../../../../../../libs/kernel/src/infrastructure/system";
import { generateRecoveryCodes, hashRecoveryCode, totp } from "../../../../../../libs/kernel/src/infrastructure/totp";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import type { Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import { generateProof, hashProof } from "../../../../../../libs/kernel/src/infrastructure/otp";
import { EmailVerificationService } from "../verification/application/EmailVerificationService";
import { PLATFORM_MAILER, VerificationModule } from "../verification/verification.module";
import { StaffEmailAccess } from "./application/use-cases/StaffEmailAccess";
import { StaffInvitations } from "./application/use-cases/StaffInvitations";
import { EmailInvitationMailer } from "./infrastructure/invitation-mailer";
import { PrismaStaffInvitationRepository } from "./infrastructure/PrismaStaffInvitationRepository";
import { InvitationsController } from "./presentation/http/invitations.controller";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import {
  type AccessTokenService,
  type ChallengeService,
  IDENTITY_TOKENS as T,
  type IdentitySettings,
  type PasswordHasher,
  type RecoveryCodes,
  type SecretCipher,
  type StaffActivityQuery,
  type TotpService,
} from "./application/ports";
import { AuthenticateStaffMember } from "./application/use-cases/AuthenticateStaffMember";
import { GetStaffProfile } from "./application/use-cases/GetStaffProfile";
import { IdentifyStaffMember } from "./application/use-cases/IdentifyStaffMember";
import { RegisterStaffMember } from "./application/use-cases/RegisterStaffMember";
import {
  ActivateStaffMember,
  ChangeStaffRole,
  ResetStaffMfa,
  SetStaffPermissions,
  SuspendStaffMember,
} from "./application/use-cases/staff/ManageStaffMember";
import { GetStaffActivity, GetStaffMember, ListStaffMembers } from "./application/use-cases/staff/QueryStaff";
import { ResolveStaffAccess } from "./application/use-cases/staff/ResolveStaffAccess";
import { StaffSecurity } from "./application/use-cases/StaffSecurity";
import type { StaffMemberRepository } from "./domain/StaffMemberRepository";
import type { StaffSessionRepository } from "./domain/StaffSession";
import { BcryptPasswordHasher } from "../../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { JwtAccessTokenService, JwtChallengeService } from "./infrastructure/JwtAccessTokenService";
import { PrismaStaffActivityQuery } from "./infrastructure/PrismaStaffActivityQuery";
import { PrismaStaffMemberRepository } from "./infrastructure/PrismaStaffMemberRepository";
import { PrismaStaffSessionRepository } from "./infrastructure/PrismaStaffSessionRepository";
import { AuthController } from "./presentation/http/auth.controller";
import { StaffAuthGuard, StaffPermissionsGuard } from "./presentation/http/staff-auth";
import { StaffController } from "./presentation/http/staff.controller";

/**
 * Contexto delimitado "Identity" do módulo Plataforma (equipa interna).
 * Este ficheiro é o composition root: liga cada porta à sua implementação.
 * Domínio e casos de uso não sabem que o Nest existe.
 */
@Module({
  imports: [
    PlatformDatabaseModule,
    VerificationModule,
    // Tokens da equipa: par de chaves ES256 próprio (diferente do dos colégios).
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        privateKey: readKeyFile(config.get("STAFF_JWT_PRIVATE_KEY_FILE", { infer: true })),
        publicKey: readKeyFile(config.get("STAFF_JWT_PUBLIC_KEY_FILE", { infer: true })),
        signOptions: { algorithm: "ES256" },
        verifyOptions: { algorithms: ["ES256"] },
      }),
    }),
  ],
  controllers: [AuthController, StaffController, InvitationsController],
  providers: [
    // --- portas → adaptadores
    { provide: T.Clock, useValue: systemClock },
    { provide: T.IdGenerator, useValue: uuidGenerator },
    { provide: T.PasswordHasher, useFactory: () => new BcryptPasswordHasher() },
    {
      provide: T.IdentitySettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): IdentitySettings => ({
        defaultPhoneCountryCode: config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
      }),
    },
    {
      provide: T.StaffMemberRepository,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaStaffMemberRepository(prisma),
    },
    {
      provide: T.AccessTokenService,
      inject: [JwtService, ConfigService],
      useFactory: (jwt: JwtService, config: ConfigService<Env, true>) =>
        new JwtAccessTokenService(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
    },

    // --- 2FA e sessões
    {
      provide: T.StaffSessionRepository,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaStaffSessionRepository(prisma),
    },
    { provide: T.ChallengeService, inject: [JwtService], useFactory: (jwt: JwtService) => new JwtChallengeService(jwt) },
    {
      // segredos TOTP cifrados na BD com uma chave que só o platform-api tem
      provide: T.SecretCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new SecretBox(readKeyFile(config.get("MFA_ENCRYPTION_KEY_FILE", { infer: true }))),
    },
    { provide: T.TotpService, useValue: { generateSecret: totp.generateSecret, otpauthUrl: totp.otpauthUrl, verify: totp.verify } },
    { provide: T.RecoveryCodes, useValue: { generate: () => generateRecoveryCodes(), hash: hashRecoveryCode } },
    {
      provide: StaffSecurity,
      inject: [
        T.StaffMemberRepository,
        T.StaffSessionRepository,
        T.AccessTokenService,
        T.ChallengeService,
        T.SecretCipher,
        T.TotpService,
        T.RecoveryCodes,
        T.IdGenerator,
        T.Clock,
      ],
      useFactory: (
        members: StaffMemberRepository,
        sessions: StaffSessionRepository,
        tokens: AccessTokenService,
        challenges: ChallengeService,
        cipher: SecretCipher,
        totpService: TotpService,
        recovery: RecoveryCodes,
        ids: IdGenerator,
        clock: Clock,
      ) => new StaffSecurity(members, sessions, tokens, challenges, cipher, totpService, recovery, ids, clock),
    },
    {
      provide: ResolveStaffAccess,
      inject: [T.StaffMemberRepository, T.StaffSessionRepository, T.Clock],
      useFactory: (members: StaffMemberRepository, sessions: StaffSessionRepository, clock: Clock) =>
        new ResolveStaffAccess(members, sessions, clock),
    },

    // --- casos de uso
    {
      provide: IdentifyStaffMember,
      inject: [T.StaffMemberRepository, T.IdentitySettings],
      useFactory: (repo: StaffMemberRepository, settings: IdentitySettings) => new IdentifyStaffMember(repo, settings),
    },
    // --- convites (só quem é convidado cria conta)
    {
      provide: StaffInvitations,
      inject: [PlatformPrismaService, T.StaffMemberRepository, PLATFORM_MAILER, T.IdGenerator, T.Clock, T.IdentitySettings, ConfigService],
      useFactory: (
        prisma: PlatformPrismaService,
        repo: StaffMemberRepository,
        mailer: Mailer,
        ids: IdGenerator,
        clock: Clock,
        settings: IdentitySettings,
        config: ConfigService<Env, true>,
      ) =>
        new StaffInvitations(
          new PrismaStaffInvitationRepository(prisma),
          repo,
          new EmailInvitationMailer(mailer),
          { generate: generateProof, hash: hashProof },
          ids,
          clock,
          { ...settings, signUpUrl: `${config.get("FRONTEND_URL", { infer: true }).replace(/\/$/, "")}/criar-conta` },
        ),
    },
    {
      provide: RegisterStaffMember,
      inject: [T.StaffMemberRepository, T.PasswordHasher, T.IdGenerator, T.Clock, T.IdentitySettings, EmailVerificationService, StaffInvitations],
      useFactory: (
        repo: StaffMemberRepository,
        hasher: PasswordHasher,
        ids: IdGenerator,
        clock: Clock,
        settings: IdentitySettings,
        verification: EmailVerificationService,
        invitations: StaffInvitations,
      ) => new RegisterStaffMember(repo, hasher, ids, clock, settings, verification, invitations),
    },
    {
      provide: StaffEmailAccess,
      inject: [
        T.StaffMemberRepository,
        T.StaffSessionRepository,
        EmailVerificationService,
        T.PasswordHasher,
        StaffSecurity,
        T.Clock,
        T.IdentitySettings,
        StaffInvitations,
      ],
      useFactory: (
        repo: StaffMemberRepository,
        sessions: StaffSessionRepository,
        verification: EmailVerificationService,
        hasher: PasswordHasher,
        security: StaffSecurity,
        clock: Clock,
        settings: IdentitySettings,
        invitations: StaffInvitations,
      ) => new StaffEmailAccess(repo, sessions, verification, hasher, security, clock, settings, invitations),
    },
    {
      provide: AuthenticateStaffMember,
      inject: [T.StaffMemberRepository, T.PasswordHasher, T.Clock, T.IdentitySettings],
      useFactory: (repo: StaffMemberRepository, hasher: PasswordHasher, clock: Clock, settings: IdentitySettings) =>
        new AuthenticateStaffMember(repo, hasher, clock, settings),
    },
    {
      provide: GetStaffProfile,
      inject: [T.StaffMemberRepository],
      useFactory: (repo: StaffMemberRepository) => new GetStaffProfile(repo),
    },

    // --- gestão da equipa
    {
      provide: T.StaffActivityQuery,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaStaffActivityQuery(prisma),
    },
    ...[ListStaffMembers, GetStaffMember].map((UseCase) => ({
      provide: UseCase,
      inject: [T.StaffMemberRepository],
      useFactory: (repo: StaffMemberRepository) => new UseCase(repo),
    })),
    {
      provide: GetStaffActivity,
      inject: [T.StaffMemberRepository, T.StaffActivityQuery],
      useFactory: (repo: StaffMemberRepository, activity: StaffActivityQuery) => new GetStaffActivity(repo, activity),
    },
    ...[ActivateStaffMember, SuspendStaffMember, ChangeStaffRole, SetStaffPermissions, ResetStaffMfa].map((Command) => ({
      provide: Command,
      inject: [T.StaffMemberRepository, T.Clock],
      useFactory: (repo: StaffMemberRepository, clock: Clock) => new Command(repo, clock),
    })),

    // --- guards (exportados para outros contextos do módulo Plataforma)
    StaffAuthGuard,
    StaffPermissionsGuard,
  ],
  exports: [T.AccessTokenService, ResolveStaffAccess, StaffAuthGuard, StaffPermissionsGuard],
})
export class IdentityModule {}
