import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { NoTeachersGuard, RequirePermission } from "../../identity/presentation/http/permissions";
import { SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Registry } from "../application/Registry";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaRegistryRepository } from "../infrastructure/prisma-registry";

const HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = { GUARDIAN_NOT_FOUND: HttpStatus.NOT_FOUND };
const id = new ParseUUIDPipe({ version: "4" });
const page = z.coerce.number().int().min(1).max(10_000).optional();
const enrollmentsQuery = z.object({ year: z.uuid().optional(), class: z.uuid().optional(), status: z.enum(["ACTIVE", "CANCELLED"]).optional(), q: z.string().max(80).optional(), page });
const guardiansQuery = z.object({ q: z.string().max(80).optional(), page });
const statsQuery = z.object({ year: z.uuid().optional() });
const repo = (t: TenantContext) => new PrismaRegistryRepository(t.db);

/**
 * Secretaria · registos: matrículas (todas, com filtros), encarregados (lista e ficha) e os números
 * da secretaria para o Início. Ver as listas: admissions.students.view (dados pessoais) · números: admissions.access.
 */
@ApiTags("Portal · Secretaria · Registos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class RegistryController {
  constructor(private readonly registry: Registry) {}

  @Get("enrollments")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Matrículas: pesquisa (aluno, n.º de matrícula, n.º de aluno), filtros (ano, classe, estado), páginas" })
  enrollments(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(enrollmentsQuery)) q: z.infer<typeof enrollmentsQuery>) {
    return this.registry.enrollments(repo(t), { yearId: q.year, classId: q.class, status: q.status, q: q.q, page: q.page });
  }

  @Get("guardians")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Encarregados de educação: pesquisa (nome, email, telefone, educando), os educandos de cada um" })
  guardians(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(guardiansQuery)) q: z.infer<typeof guardiansQuery>) {
    return this.registry.guardians(repo(t), { q: q.q, page: q.page });
  }

  @Get("guardians/:id")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Ficha do encarregado: contactos, dados, conta na área da família e os educandos" })
  async guardian(@CurrentTenant() t: TenantContext, @Param("id", id) guardianId: string) {
    return unwrap(await this.registry.guardian(repo(t), guardianId), HTTP);
  }

  @Get("stats")
  @RequirePermission("admissions.access")
  @ApiOperation({ summary: "Números da secretaria (Início): alunos por classe, matrículas por mês, sexo, inscrições, renovações" })
  stats(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(statsQuery)) q: z.infer<typeof statsQuery>) {
    return this.registry.stats(repo(t), q.year);
  }
}
