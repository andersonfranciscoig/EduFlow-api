import { Controller, Get, Param, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { GradebookViewer } from "../application/Gradebook";
import { GradeSheets } from "../application/GradeSheets";
import { GradingDashboard } from "../application/GradingDashboard";
import { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import { GRADING_HTTP } from "./grading-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const yearQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional() }));
const sheetQuery = new ZodValidationPipe(z.object({ periodo: z.coerce.number().int().min(0).max(3) }));
const dashQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional(), periodo: z.coerce.number().int().min(0).max(3).optional() }));

/** PAUTAS (A4 e .xlsx) e o PAINEL da avaliação: só o que foi publicado; consulta com grading.access. */
@ApiTags("Portal · Avaliação · Pautas e painel")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/grading")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class GradeSheetsController {
  constructor(
    private readonly sheets: GradeSheets,
    private readonly dashboard: GradingDashboard,
  ) {}

  @Get("sheets")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "As turmas de um ano (?ano=) e, por período, quantas disciplinas já têm as classificações publicadas" })
  async overview(@CurrentTenant() t: TenantContext, @Query(yearQuery) q: { ano?: string }) {
    return this.sheets.overview(this.books(t), q.ano);
  }

  @Get("sheets/:groupId")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "A pauta de uma turma num período (?periodo=, 0 = final do ano, com o resultado): só o publicado" })
  async sheet(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Query(sheetQuery) q: { periodo: number }) {
    return unwrap(await this.sheets.sheet(this.books(t), await this.viewer(t, u), t.entry.schoolName, groupId, q.periodo), GRADING_HTTP);
  }

  @Get("sheets/:groupId/xlsx")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "A pauta em Excel (.xlsx)" })
  async workbook(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Query(sheetQuery) q: { periodo: number }, @Res({ passthrough: true }) res: Response) {
    const f = unwrap(await this.sheets.workbook(this.books(t), await this.viewer(t, u), t.entry.schoolName, groupId, q.periodo), GRADING_HTTP);
    const ascii = f.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
    res.set({
      "Content-Type": f.mimeType,
      "Content-Length": String(f.content.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return new StreamableFile(f.content);
  }

  @Get("dashboard")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Painel da avaliação (?ano=&periodo=): andamento do fecho, médias e positivas por classe e disciplina, alunos com mais negativas, resultados do ano" })
  async panel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(dashQuery) q: { ano?: string; periodo?: number }) {
    return this.dashboard.view(this.books(t), await this.viewer(t, u), q.ano, q.periodo);
  }

  private books(t: TenantContext) {
    return PrismaGradebookRepository.for(t.db);
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<GradebookViewer> {
    const p = await permissionsOf(t.db, u);
    return { userId: u.id, support: !!u.support, canView: p.includes("grading.access"), canValidate: p.includes("grading.results.validate"), canPublish: p.includes("grading.results.publish"), canRectify: p.includes("grading.results.rectify") };
  }
}
