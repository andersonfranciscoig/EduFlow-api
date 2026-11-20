import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { BcryptPasswordHasher } from "../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { FamilyAuth } from "./application/FamilyAuth";
import { FamilyHome } from "./application/FamilyHome";
import { EmailFamilyMailer } from "./infrastructure/family-mailer";
import { JwtFamilyTokens } from "./infrastructure/family-tokens";
import { FamilyAuthGuard } from "./presentation/family-auth";
import { FamilyAuthController, FamilyController } from "./presentation/family.controller";

/**
 * Contexto "Área da família" (na BD de cada colégio): contas de família — encarregados e alunos
 * maiores — à parte das contas da equipa, alunos, encarregados e a relação entre eles.
 * Mesmo par ES256 do school-api, com audiências próprias.
 */
@Module({
  imports: [
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
  controllers: [FamilyAuthController, FamilyController],
  providers: [
    {
      provide: FamilyAuth,
      inject: [ConfigService, JwtService],
      useFactory: (config: ConfigService<Env, true>, jwt: JwtService) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new FamilyAuth(
          new EmailFamilyMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })),
          new JwtFamilyTokens(jwt, config.get("JWT_EXPIRES_IN_SECONDS", { infer: true })),
          new BcryptPasswordHasher(),
          uuidGenerator,
          systemClock,
          config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
        );
      },
    },
    {
      provide: FamilyHome,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        // o convite ao aluno que fez 18 anos vai por email
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new FamilyHome(systemClock, config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }), new EmailFamilyMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })), uuidGenerator);
      },
    },
    FamilyAuthGuard,
  ],
  exports: [FamilyAuth, FamilyAuthGuard],
})
export class FamilyModule {}
