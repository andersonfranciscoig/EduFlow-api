import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BcryptPasswordHasher } from "../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { IdentityModule } from "../identity/identity.module";
import { HrSettings } from "./application/HrSettings";
import { Registration } from "./application/Registration";
import { EmailRegistrationMailer } from "./infrastructure/registration-mailer";
import { HrSettingsController } from "./presentation/hr-settings.controller";
import { PublicRegistrationController, RegistrationRequestsController } from "./presentation/registration.controller";

/**
 * Contexto "Recursos Humanos" do portal (na BD de cada colégio).
 *   configuração do cadastro (campos, tipos, documentos, versões)
 *   pedidos de cadastro (página pública) → análise pelo RH → convite por email
 * O formulário de cadastro e os funcionários chegam nas fases seguintes.
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard + PermissionsGuard
  controllers: [HrSettingsController, PublicRegistrationController, RegistrationRequestsController],
  providers: [
    { provide: HrSettings, useFactory: () => new HrSettings(uuidGenerator, systemClock) },
    {
      provide: Registration,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new Registration(
          new EmailRegistrationMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })),
          new BcryptPasswordHasher(),
          uuidGenerator,
          systemClock,
          config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }),
        );
      },
    },
  ],
})
export class HrModule {}
