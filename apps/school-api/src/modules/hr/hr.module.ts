import { readFileSync } from "node:fs";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BcryptPasswordHasher } from "../../../../../libs/kernel/src/infrastructure/BcryptPasswordHasher";
import { readBackupKey } from "../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { IdentityModule } from "../identity/identity.module";
import { Employees } from "./application/Employees";
import type { HrFileStore } from "./application/employee-ports";
import { HrSettings } from "./application/HrSettings";
import { Registration } from "./application/Registration";
import { LocalHrFiles, UploadThingHrFiles } from "./infrastructure/hr-file-store";
import { EmailRegistrationMailer, employeeMailer } from "./infrastructure/registration-mailer";
import { ApplicantFormController, EmployeesController } from "./presentation/employees.controller";
import { HrSettingsController } from "./presentation/hr-settings.controller";
import { PublicRegistrationController, RegistrationRequestsController } from "./presentation/registration.controller";

const HR_MAILER = Symbol("HrMailer");
const HR_FILES = Symbol("HrFiles");

/**
 * Contexto "Recursos Humanos" do portal (na BD de cada colégio).
 *   configuração do cadastro (campos, tipos, documentos, versões)
 *   pedidos de cadastro (página pública) → análise pelo RH → convite por email
 *   formulário por passos pelo convite (gravação automática, ficheiros cifrados) → submissão
 *   funcionários: análise, aprovação (n.º de funcionário), correções, vínculo, histórico
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard + PermissionsGuard
  controllers: [HrSettingsController, PublicRegistrationController, RegistrationRequestsController, ApplicantFormController, EmployeesController],
  providers: [
    { provide: HrSettings, useFactory: () => new HrSettings(uuidGenerator, systemClock) },
    {
      provide: HR_MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new EmailRegistrationMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true }));
      },
    },
    {
      // documentos dos funcionários: a app do UploadThing SÓ do RH, cifrados antes de sair
      provide: HR_FILES,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): HrFileStore => {
        const keyFile = config.get("HR_FILES_KEY_FILE", { infer: true });
        const key = keyFile ? readBackupKey(readFileSync(keyFile, "utf8")) : null;
        const store =
          config.get("HR_FILE_STORAGE", { infer: true }) === "uploadthing"
            ? new UploadThingHrFiles(readFileSync(config.get("HR_UPLOADTHING_TOKEN_FILE", { infer: true })!, "utf8"), key!, config.get("HR_UPLOADTHING_ACL", { infer: true }))
            : new LocalHrFiles(config.get("HR_STORAGE_DIR", { infer: true }), key);
        console.log(`[school-api] documentos do RH: ${store.name}`);
        return store;
      },
    },
    {
      provide: Registration,
      inject: [ConfigService, HR_MAILER],
      useFactory: (config: ConfigService<Env, true>, mailer: EmailRegistrationMailer) =>
        new Registration(mailer, new BcryptPasswordHasher(), uuidGenerator, systemClock, config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true })),
    },
    {
      provide: Employees,
      inject: [ConfigService, HR_MAILER, HR_FILES],
      useFactory: (config: ConfigService<Env, true>, mailer: EmailRegistrationMailer, files: HrFileStore) =>
        new Employees(files, employeeMailer(mailer), new BcryptPasswordHasher(), uuidGenerator, systemClock, config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true })),
    },
  ],
})
export class HrModule {}
