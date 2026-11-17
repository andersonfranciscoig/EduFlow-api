import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Attendance } from "../application/Attendance";
import { HrFileStores } from "../infrastructure/hr-file-store";
import { PrismaAttendanceRepository } from "../infrastructure/prisma-attendance";
import { sendFile } from "./employees.controller";
import { HR_HTTP } from "./hr-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const dayQuery = z.object({ date: isoDay.optional() });
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, "Mês no formato AAAA-MM.").optional() });
const dayBody = z
  .object({
    date: isoDay,
    entries: z
      .array(
        z.object({
          employeeId: z.uuid(),
          status: z.enum(["PRESENTE", "ATRASO", "FALTA", "FALTA_JUSTIFICADA"]).nullable(),
          minutesLate: z.number().int().min(1).max(600).nullish(),
          note: z.string().max(300).nullish(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .meta({ title: "HrAttendanceDay", description: "Linhas da folha do dia. status null = volta a por marcar. ATRASO exige os minutos; FALTA_JUSTIFICADA exige o motivo (note)." });

type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
const actorOf = (u: SchoolAccess) => (u.support ? { id: null, name: null } : { id: u.id, name: u.fullName });

/** Assiduidade dos funcionários. Ver: hr.attendance.view · marcar e comprovativos: hr.attendance.manage. */
@ApiTags("Portal · Recursos Humanos · Assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/hr/attendance")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class AttendanceController {
  constructor(
    private readonly attendance: Attendance,
    private readonly stores: HrFileStores,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaAttendanceRepository(t.db);
  }

  private async access(t: TenantContext, u: SchoolAccess) {
    return { manage: (await permissionsOf(t.db, u)).includes("hr.attendance.manage") };
  }

  @Get("day")
  @RequirePermission("hr.attendance.view")
  @ApiOperation({ summary: "Folha de um dia (?date=AAAA-MM-DD; por omissão hoje): funcionários ativos com o registo de cada um e as contagens" })
  async day(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(dayQuery)) q: z.infer<typeof dayQuery>) {
    return unwrap(await this.attendance.day(this.repo(t), await this.access(t, u), q), HR_HTTP);
  }

  @Put("day")
  @RequirePermission("hr.attendance.manage")
  @ApiOperation({ summary: "Gravar a folha do dia (só as linhas enviadas)", description: "Até hoje e no máximo um ano para trás. Uma presença perde o comprovativo que tivesse." })
  @ApiBody({ schema: openApi(dayBody) })
  async saveDay(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(dayBody)) body: z.infer<typeof dayBody>) {
    return unwrap(await this.attendance.saveDay(this.repo(t), this.stores.for(t.entry), actorOf(u), await this.access(t, u), body), HR_HTTP);
  }

  @Get("month")
  @RequirePermission("hr.attendance.view")
  @ApiOperation({ summary: "Mapa do mês (?month=AAAA-MM): funcionários × dias e os totais (presenças, atrasos e minutos, faltas, justificadas, por marcar)" })
  async month(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(monthQuery)) q: z.infer<typeof monthQuery>) {
    return unwrap(await this.attendance.month(this.repo(t), q), HR_HTTP);
  }

  @Post(":id/proof")
  @RequirePermission("hr.attendance.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Juntar o comprovativo de um atraso ou falta (PDF, JPG ou PNG até 10 MB; cifrado)" })
  async upload(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) recordId: string, @UploadedFile() file: Upload) {
    return unwrap(await this.attendance.uploadProof(this.repo(t), this.stores.for(t.entry), actorOf(u), recordId, file), HR_HTTP);
  }

  @Get(":id/proof")
  @RequirePermission("hr.attendance.view")
  @ApiOperation({ summary: "Ver o comprovativo (decifrado pela API; nunca há link direto)" })
  async proof(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) recordId: string, @Res({ passthrough: true }) res: Response) {
    const repo = this.repo(t);
    const f = unwrap(await this.attendance.readProof(repo, this.stores.for(t.entry), recordId), HR_HTTP);
    await repo.record("HR_ATTENDANCE_PROOF_VIEWED", f.employeeId, u.support ? null : u.id, { recordId }, new Date());
    return sendFile(res, f);
  }

  @Delete(":id/proof")
  @RequirePermission("hr.attendance.manage")
  @ApiOperation({ summary: "Retirar o comprovativo" })
  async removeProof(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) recordId: string) {
    return unwrap(await this.attendance.removeProof(this.repo(t), this.stores.for(t.entry), actorOf(u), recordId), HR_HTTP);
  }
}
