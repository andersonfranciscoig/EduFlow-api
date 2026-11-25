import { Module } from "@nestjs/common";
import type { TenantContext } from "../../tenancy/tenant-context";
import { PrismaApplicationsRepository } from "./infrastructure/prisma-applications";
import { PrismaEnrollmentsRepository } from "./infrastructure/prisma-enrollments";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer } from "../../../../../libs/kernel/src/infrastructure/mail";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { AttendanceModule } from "../attendance/attendance.module";
import { ExamsModule } from "../exams/exams.module";
import { FinanceModule } from "../finance/finance.module";
import { Payments } from "../finance/application/Payments";
import { PrismaPaymentsRepository } from "../finance/infrastructure/prisma-payments";
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
import { Renewals } from "./application/Renewals";
import { Registry } from "./application/Registry";
import { RegistryController } from "./presentation/registry.controller";
import { FamilyRenewalsController, StaffRenewalsController } from "./presentation/renewals.controller";
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
  // AttendanceModule: a assiduidade do aluno na área da família · ExamsModule: as provas do aluno
  imports: [IdentityModule, FamilyModule, HrModule, PedagogyModule, AttendanceModule, ExamsModule, FinanceModule],
  controllers: [AdmissionSettingsController, PublicAdmissionsController, FamilyApplicationsController, StaffApplicationsController, EnrollmentConfigController, StaffStudentsController, FamilyStudentsController, TeacherStudentsController, FamilyRenewalsController, StaffRenewalsController, RegistryController],
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
    { provide: Renewals, useFactory: () => new Renewals(uuidGenerator, systemClock) },
    { provide: Registry, useFactory: () => new Registry(systemClock) },
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
export class AdmissionsModule {
  constructor(payments: Payments, enrollments: Enrollments) {
    // modo automático: com os pagamentos da matrícula validados (ou isentos), matricula logo
    payments.onSettled(async (ctx, ids) => {
      const t = ctx as TenantContext;
      for (const id of ids) {
        if (await payments.pending(new PrismaPaymentsRepository(t.db), id, "MATRICULA")) continue;
        await enrollments.afterPayment(new PrismaEnrollmentsRepository(t.db), new PrismaApplicationsRepository(t.db), { name: t.entry.schoolName, slug: t.entry.slug }, id);
      }
    });
  }
}
