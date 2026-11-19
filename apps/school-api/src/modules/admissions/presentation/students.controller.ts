import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Patch, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Students } from "../application/Students";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaStudentsRepository } from "../infrastructure/prisma-students";

const STUDENTS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  STUDENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  FILE_NOT_FOUND: HttpStatus.NOT_FOUND,
};

const id = new ParseUUIDPipe({ version: "4" });
const listQuery = z.object({ q: z.string().max(80).optional(), year: z.uuid().optional(), class: z.uuid().optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).max(10_000).optional() });
const updateBody = z.record(z.string().max(40), z.unknown()).meta({ title: "StudentUpdate", description: "Os dados pessoais do aluno (as mesmas chaves do formulário de inscrição)." });
const repo = (t: TenantContext) => new PrismaStudentsRepository(t.db);

function sendFile(res: Response, f: { content: Buffer; mimeType: string; fileName: string }) {
  res.setHeader("Content-Type", f.mimeType);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return new StreamableFile(f.content);
}

/**
 * Secretaria · alunos. Ver: admissions.students.view · editar os dados pessoais: admissions.students.edit.
 * Nunca para professores (nem para o suporte: dados pessoais).
 */
@ApiTags("Portal · Secretaria · Alunos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions/students")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class StaffStudentsController {
  constructor(
    private readonly students: Students,
    private readonly stores: HrFileStores,
  ) {}

  @Get()
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Alunos: pesquisa (nome, n.º de aluno, n.º de matrícula, BI), filtros (ano, classe, estado), páginas" })
  list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.students.list(repo(t), { q: q.q, yearId: q.year, classId: q.class, status: q.status, page: q.page });
  }

  @Get(":id")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "A ficha do aluno: dados pessoais, encarregados, matrículas, inscrições, documentos e histórico" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string) {
    const canEdit = (await permissionsOf(t.db, u)).includes("admissions.students.edit");
    return unwrap(await this.students.get(repo(t), studentId, canEdit), STUDENTS_HTTP);
  }

  @Patch(":id")
  @RequirePermission("admissions.students.edit")
  @ApiOperation({ summary: "Alterar os dados pessoais (fica no histórico o que mudou)" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return unwrap(await this.students.update(repo(t), { id: u.support ? null : u.id }, studentId, body), STUDENTS_HTTP);
  }

  @Get(":id/files/:fileId")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Um ficheiro do aluno (fotografia ou documento entregue nas inscrições; decifrado pela API)" })
  async file(@CurrentTenant() t: TenantContext, @Param("id", id) studentId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.students.file(repo(t), this.stores.for(t.entry), studentId, fileId), STUDENTS_HTTP));
  }
}

/** Área da família · os alunos da conta (o próprio aluno maior, ou os educandos menores que gere). */
@ApiTags("Área da família · Alunos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family/students")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyStudentsController {
  constructor(
    private readonly students: Students,
    private readonly stores: HrFileStores,
  ) {}

  @Get(":id")
  @ApiOperation({ summary: "O painel do aluno: dados, encarregados, matrículas, inscrições e documentos (só leitura)" })
  async get(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    return unwrap(await this.students.familyGet(repo(t), f.account.id, studentId), STUDENTS_HTTP);
  }

  @Get(":id/files/:fileId")
  @ApiOperation({ summary: "Um ficheiro do aluno (decifrado pela API)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.students.familyFile(repo(t), this.stores.for(t.entry), f.account.id, studentId, fileId), STUDENTS_HTTP));
  }
}
