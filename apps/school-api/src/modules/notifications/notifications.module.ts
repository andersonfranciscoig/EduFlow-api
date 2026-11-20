import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsCenter } from "./application/NotificationsCenter";
import { Notifier } from "./infrastructure/notifier";
import { NotificationsController } from "./presentation/notifications.controller";

/**
 * Notificações da equipa (caixa, preferências), tipos do colégio e histórico de envios.
 * Exporta o Notifier: os outros módulos (assiduidade…) avisam por aqui.
 */
@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController],
  providers: [
    { provide: NotificationsCenter, useFactory: () => new NotificationsCenter(systemClock) },
    {
      provide: Notifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new Notifier(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true }));
      },
    },
  ],
  exports: [Notifier],
})
export class NotificationsModule {}
