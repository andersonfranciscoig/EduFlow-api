import { Body, Controller, Get, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { NoTeachersGuard, RequirePermission } from "../../identity/presentation/http/permissions";
import { SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Renewals } from "../application/Renewals";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaAdmissionFormsRepository } from "../infrastructure/prisma-admission-forms";
import { PrismaApplicationsRepository } from "../infrastructure/prisma-applications";
import { PrismaRenewalsRepository } from "../infrastructure/prisma-renewals";

const RENEWALS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  STUDENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  RENEWALS_CLOSED: HttpStatus.CONFLICT,
};

const startBody = z.object({ studentId: z.uuid() }).meta({ title: "RenewalStart", description: "O aluno a renovar (o próprio aluno maior, ou um educando menor que a conta gere)." });
const staffQuery = z.object({ year: z.uuid().optional() });
const repo = (t: TenantContext) => new PrismaRenewalsRepository(t.db);

/** Área da família · renovação de matrícula dos alunos da conta. */
@ApiTags("Área da família · Renovações")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family/renewals")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyRenewalsController {
  constructor(private readonly renewals: Renewals) {}

  @Get()
  @ApiOperation({ summary: "Os alunos matriculados da conta e o estado da renovação de cada um (aberta, por abrir, em curso, renovada…)" })
  list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.renewals.familyList(repo(t), f.account);
  }

  @Post()
  @ApiOperation({
    summary: "Começar a renovação de um aluno",
    description: "Cria a inscrição RENOVACAO já ligada ao aluno e preenchida (dados do aluno e do encarregado, ano e classe seguintes). Se já existir, devolve-a.",
  })
  @ApiBody({ schema: openApi(startBody) })
  async start(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(startBody)) body: z.infer<typeof startBody>) {
    return unwrap(await this.renewals.start(repo(t), new PrismaApplicationsRepository(t.db), new PrismaAdmissionFormsRepository(t.db), f.account, body.studentId), RENEWALS_HTTP);
  }
}

/** Secretaria · acompanhamento das renovações de um ano letivo. Ver: admissions.applications.view. */
@ApiTags("Portal · Secretaria · Renovações")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions/renewals")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class StaffRenewalsController {
  constructor(private readonly renewals: Renewals) {}

  @Get()
  @RequirePermission("admissions.applications.view")
  @ApiOperation({ summary: "Renovações de um ano (?year=; por omissão o que tem o período aberto): os alunos do ano anterior e o ponto da renovação de cada um" })
  list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(staffQuery)) q: z.infer<typeof staffQuery>) {
    return this.renewals.staff(repo(t), q.year);
  }
}
