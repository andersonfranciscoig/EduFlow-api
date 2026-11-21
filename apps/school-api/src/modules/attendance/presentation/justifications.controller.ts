import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import { sendFile } from "../../hr/presentation/employees.controller";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { Justifications } from "../application/Justifications";
import { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import { PrismaJustificationsRepository } from "../infrastructure/prisma-justifications";
import { PrismaOccurrencesRepository } from "../infrastructure/prisma-occurrences";
import { ATTENDANCE_HTTP } from "./attendance-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
const listQuery = new ZodValidationPipe(z.object({ estado: z.string().max(20).optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }));
const approveBody = z.object({ note: z.string().max(300).nullish() }).meta({ title: "JustificationApprove" });
const rejectBody = z.object({ note: z.string().max(300) }).meta({ title: "JustificationReject", description: "Motivo (obrigatório)." });

/**
 * Justificações das faltas dos professores.
 *  Professor (`me/…`): as suas faltas e atrasos, justificar (motivo + comprovativo opcional), retirar.
 *  RH (`teachers/justifications…`): ver (attendance.teachers.view), aceitar/não aceitar (.manage).
 */
@ApiTags("Portal · Assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class JustificationsController {
  constructor(
    private readonly justifications: Justifications,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaJustificationsRepository(t.db);
  }
  private occ(t: TenantContext) {
    return new PrismaOccurrencesRepository(t.db);
  }
  private notify(t: TenantContext) {
    return this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName });
  }

  // ---------------------------------------------------------------- o professor

  @Get("me/occurrences")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas faltas e atrasos (com as justificações)" })
  async mine(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.justifications.mine(this.repo(t), this.occ(t), u.id), ATTENDANCE_HTTP);
  }

  @Post("me/occurrences/:id/justification")
  @TeacherMay()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Justificar uma falta ou atraso: motivo (campo reason) e comprovativo opcional (PDF/JPG/PNG até 10 MB; cifrado)" })
  async submit(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) occurrenceId: string, @Body() body: { reason?: string }, @UploadedFile() file: Upload) {
    return unwrap(
      await this.justifications.submit(this.repo(t), this.occ(t), this.stores.for(t.entry), u.id, occurrenceId, { reason: String(body?.reason ?? ""), file }, new PrismaDeadlineRepository(t.db), this.notify(t)),
      ATTENDANCE_HTTP,
    );
  }

  @Delete("me/justifications/:id")
  @TeacherMay()
  @ApiOperation({ summary: "Retirar a minha justificação (só enquanto está em análise)" })
  async withdraw(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) jid: string) {
    return unwrap(await this.justifications.withdraw(this.repo(t), this.occ(t), this.stores.for(t.entry), u.id, jid), ATTENDANCE_HTTP);
  }

  @Get("justifications/:id/proof")
  @TeacherMay()
  @ApiOperation({ summary: "O comprovativo (decifrado pela API): do próprio professor ou para quem consulta as faltas dos professores" })
  async proof(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) jid: string, @Res({ passthrough: true }) res: Response) {
    const canView = u.role !== "PROFESSOR" && (await permissionsOf(t.db, u)).includes("attendance.teachers.view");
    return sendFile(res, unwrap(await this.justifications.proof(this.repo(t), this.stores.for(t.entry), { userId: u.id, canView }, jid), ATTENDANCE_HTTP));
  }

  // ---------------------------------------------------------------- o RH

  @Get("teachers/justifications")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Justificações dos professores (filtro: estado; página)" })
  list(@CurrentTenant() t: TenantContext, @Query(listQuery) q: { estado?: string; pagina?: number }) {
    return this.justifications.list(this.repo(t), { status: q.estado, page: q.pagina });
  }

  @Post("teachers/justifications/:id/aceitar")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Aceitar: a ocorrência fica justificada" })
  @ApiBody({ schema: openApi(approveBody) })
  async approve(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) jid: string, @Body(new ZodValidationPipe(approveBody)) body: z.infer<typeof approveBody>) {
    return unwrap(await this.justifications.approve(this.repo(t), this.occ(t), { id: u.id, canManage: true }, jid, body.note ?? null, this.notify(t)), ATTENDANCE_HTTP);
  }

  @Post("teachers/justifications/:id/recusar")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Não aceitar (com o motivo): a ocorrência fica por justificar" })
  @ApiBody({ schema: openApi(rejectBody) })
  async reject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) jid: string, @Body(new ZodValidationPipe(rejectBody)) body: z.infer<typeof rejectBody>) {
    return unwrap(await this.justifications.reject(this.repo(t), this.occ(t), { id: u.id, canManage: true }, jid, body.note, this.notify(t)), ATTENDANCE_HTTP);
  }
}
