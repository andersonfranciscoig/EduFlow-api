import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { NoTeachersGuard, RequirePermission } from "../../identity/presentation/http/permissions";
import { SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { FinanceReports, REPORT_TYPES, type ReportType } from "../application/FinanceReports";
import { PrismaFinanceReports } from "../infrastructure/prisma-finance-reports";
import { PAYMENTS_HTTP } from "./payments.controller";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const yearQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional() }));
const query = new ZodValidationPipe(z.object({ ano: z.uuid().optional(), classe: z.uuid().optional(), de: day.optional(), ate: day.optional() }));
const type = new ZodValidationPipe(z.enum(Object.keys(REPORT_TYPES) as [ReportType, ...ReportType[]], { error: "Relatório desconhecido." }));

/** Painel e relatórios das finanças (só leitura): finance.reports.view. */
@ApiTags("Portal · Finanças · Relatórios")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/finance/reports")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class FinanceReportsController {
  constructor(private readonly reports: FinanceReports) {}

  @Get("overview")
  @RequirePermission("finance.reports.view")
  @ApiOperation({ summary: "Painel do ano letivo: recebido, em validação, em atraso, despesas e os gráficos" })
  overview(@CurrentTenant() t: TenantContext, @Query(yearQuery) q: { ano?: string }) {
    return this.reports.overview(new PrismaFinanceReports(t.db), q.ano);
  }

  @Get("options")
  @RequirePermission("finance.reports.view")
  @ApiOperation({ summary: "Os relatórios, os anos letivos e as classes" })
  options(@CurrentTenant() t: TenantContext, @Query(yearQuery) q: { ano?: string }) {
    return this.reports.options(new PrismaFinanceReports(t.db), q.ano);
  }

  @Get(":type")
  @RequirePermission("finance.reports.view")
  @ApiOperation({ summary: "Um relatório (RECEITAS, DIVIDAS, DESPESAS, RESULTADO, ISENCOES): números e tabelas" })
  async report(@CurrentTenant() t: TenantContext, @Param("type", type) reportType: ReportType, @Query(query) q: { ano?: string; classe?: string; de?: string; ate?: string }) {
    return unwrap(await this.reports.report(new PrismaFinanceReports(t.db), reportType, { yearId: q.ano, classId: q.classe, from: q.de, to: q.ate }), PAYMENTS_HTTP);
  }
}
