import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { AdmissionForms } from "./application/AdmissionForms";
import { AdmissionSettings } from "./application/AdmissionSettings";
import { ApplicationReview } from "./application/ApplicationReview";
import { Applications } from "./application/Applications";
import { EmailApplicationsMailer } from "./infrastructure/applications-mailer";
import { AdmissionSettingsController } from "./presentation/admission-settings.controller";
import { Enrollments } from "./application/Enrollments";
import { Students } from "./application/Students";
import { PedagogyModule } from "../pedagogy/pedagogy.module";
import { FamilyStudentsController, StaffStudentsController, TeacherStudentsController } from "./presentation/students.controller";
import { EnrollmentConfigController, FamilyApplicationsController, PublicAdmissionsController, StaffApplicationsController } from "./presentation/applications.controller";

/**
 * Contexto "Secretaria · Inscrições e matrículas" (na BD de cada colégio).
 * A: configuração — períodos, documentos e formulários (com versões).
 * C: inscrição online pela família (rascunho por passos, ficheiros cifrados, submissão).
 * (Seguem-se: análise, matrícula, renovação.)
 */
@Module({
  // IdentityModule: SchoolAuthGuard + permissões · FamilyModule: FamilyAuthGuard · HrModule: ficheiros cifrados do colégio
  // PedagogyModule: o horário da turma (família) e o acesso do professor às suas turmas
  imports: [IdentityModule, FamilyModule, HrModule, PedagogyModule],
  controllers: [AdmissionSettingsController, PublicAdmissionsController, FamilyApplicationsController, StaffApplicationsController, EnrollmentConfigController, StaffStudentsController, FamilyStudentsController, TeacherStudentsController],
  providers: [
    { provide: AdmissionSettings, useFactory: () => new AdmissionSettings(uuidGenerator, systemClock) },
    { provide: AdmissionForms, useFactory: () => new AdmissionForms(uuidGenerator, systemClock) },
    {
      provide: Applications,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new Applications(uuidGenerator, systemClock, new EmailApplicationsMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })), config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true }));
      },
    },
    {
      provide: ApplicationReview,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new ApplicationReview(systemClock, new EmailApplicationsMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })));
      },
    },
    { provide: Students, inject: [ConfigService], useFactory: (config: ConfigService<Env, true>) => new Students(systemClock, config.get("DEFAULT_PHONE_COUNTRY_CODE", { infer: true })) },
    {
      provide: Enrollments,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const keyFile = config.get("EMAIL_API_KEY_FILE", { infer: true });
        const settings = { from: config.get("EMAIL_FROM", { infer: true }), fromName: config.get("EMAIL_FROM_NAME", { infer: true }), replyTo: config.get("EMAIL_REPLY_TO", { infer: true }) };
        const mailer = config.get("EMAIL_PROVIDER", { infer: true }) === "brevo" && keyFile ? new BrevoMailer(readKeyFile(keyFile), settings) : new ConsoleMailer();
        return new Enrollments(systemClock, new EmailApplicationsMailer(mailer, config.get("PORTAL_URL_TEMPLATE", { infer: true })));
      },
    },
  ],
})
export class AdmissionsModule {}
