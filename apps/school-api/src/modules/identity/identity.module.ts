import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import type { Clock, IdGenerator } from "../../../../../libs/kernel/src/application/ports";
import { BcryptPasswordHasher } from "../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { SecretBox } from "../../../../../libs/kernel/src/infrastructure/secret-box";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { generateRecoveryCodes, hashRecoveryCode, totp } from "../../../../../libs/kernel/src/infrastructure/totp";
import type { Env } from "../../config/env";
import { AccountRecovery } from "./application/AccountRecovery";
import { GetProfile } from "./application/GetProfile";
import {
  type AccessTokenService,
  type ChallengeService,
  type CodeMailer,
  IDENTITY_TOKENS as T,
  type IdentitySettings,
  type PasswordHasher,
  type RecoveryCodes,
  type SecretCipher,
  type TotpService,
} from "./application/ports";
import { SchoolSecurity } from "./application/SchoolSecurity";
import { SchoolSignIn } from "./application/SchoolSignIn";
import { EmailCodeMailer } from "./infrastructure/code-mailer";
import { JwtAccessTokenService, JwtChallengeService } from "./infrastructure/jwt-tokens";
import { TenantScopes } from "./infrastructure/tenant-scopes";
import { AuthController } from "./presentation/http/auth.controller";
import { SchoolAuthGuard } from "./presentation/http/school-auth";

/**
 * Contexto "Identity" do portal do colégio — composition root.
 * Domínio e casos de uso não sabem que o Nest existe.
 */
@Module({
  imports: [
    // Par ES256 próprio: diferente do da equipa EduFlow e do dos responsáveis.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        privateKey: readKeyFile(config.get("SCHOOL_JWT_PRIVATE_KEY_FILE", { infer: true })),
        publicKey: readKeyFile(config.get("SCHOOL_JWT_PUBLIC_KEY_FILE", { infer: true })),
        signOptions: { algorithm: "ES256" },
        verifyOptions: { algorithms: ["ES256"] },
      }),
    }),
  ],
  controllers: [AuthController],
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
      provide: T.AccessTokenService,
      inject: [JwtService, ConfigService],
      useFactory: (jwt: JwtService, config: ConfigService<Env, true>) =>
        new JwtAccessTokenService(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
    },
    { provide: T.ChallengeService, inject: [JwtService], useFactory: (jwt: JwtService) => new JwtChallengeService(jwt) },
    {
      // segredos TOTP cifrados nas BDs dos colégios com uma chave que só o school-api tem
      provide: T.SecretCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => new SecretBox(readKeyFile(config.get("SCHOOL_MFA_KEY_FILE", { infer: true }))),
    },
    { provide: T.TotpService, useValue: { generateSecret: totp.generateSecret, otpauthUrl: totp.otpauthUrl, verify: totp.verify } },
    { provide: T.RecoveryCodes, useValue: { generate: () => generateRecoveryCodes(), hash: hashRecoveryCode } },
    {
      provide: T.CodeMailer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): CodeMailer => {
        const settings = {
          from: config.get("EMAIL_FROM", { infer: true }),
          fromName: config.get("EMAIL_FROM_NAME", { infer: true }),
          replyTo: config.get("EMAIL_REPLY_TO", { infer: true }),
        };
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const mailer =
          config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile
            ? new BrevoMailer(readKeyFile(keyFile), settings)
            : new ConsoleMailer();
        return new EmailCodeMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true }));
      },
    },
    TenantScopes,

    // --- casos de uso
    {
      provide: SchoolSecurity,
      inject: [T.AccessTokenService, T.ChallengeService, T.SecretCipher, T.TotpService, T.RecoveryCodes, T.IdGenerator, T.Clock],
      useFactory: (
        tokens: AccessTokenService,
        challenges: ChallengeService,
        cipher: SecretCipher,
        totpService: TotpService,
        recovery: RecoveryCodes,
        ids: IdGenerator,
        clock: Clock,
      ) => new SchoolSecurity(tokens, challenges, cipher, totpService, recovery, ids, clock),
    },
    {
      provide: SchoolSignIn,
      inject: [T.PasswordHasher, SchoolSecurity, T.Clock, T.IdentitySettings],
      useFactory: (hasher: PasswordHasher, security: SchoolSecurity, clock: Clock, settings: IdentitySettings) =>
        new SchoolSignIn(hasher, security, clock, settings),
    },
    {
      provide: AccountRecovery,
      inject: [T.ChallengeService, T.CodeMailer, T.PasswordHasher, SchoolSecurity, T.IdGenerator, T.Clock, T.IdentitySettings],
      useFactory: (
        challenges: ChallengeService,
        mailer: CodeMailer,
        hasher: PasswordHasher,
        security: SchoolSecurity,
        ids: IdGenerator,
        clock: Clock,
        settings: IdentitySettings,
      ) => new AccountRecovery(challenges, mailer, hasher, security, ids, clock, settings),
    },
    { provide: GetProfile, useFactory: () => new GetProfile() },

    // --- guard (exportado para os próximos contextos do portal: turmas, alunos…)
    SchoolAuthGuard,
  ],
  exports: [T.AccessTokenService, SchoolSecurity, TenantScopes, SchoolAuthGuard],
})
export class IdentityModule {}
