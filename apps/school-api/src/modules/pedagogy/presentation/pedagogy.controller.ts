import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { PedagogyActor } from "../application/ports";
import { Pedagogy } from "../application/Pedagogy";
import type { PedagogyErrorCode } from "../domain/academic";
import { PrismaPedagogyRepository } from "../infrastructure/prisma-pedagogy";

const HTTP: Partial<Record<PedagogyErrorCode, HttpStatus>> = {
  YEAR_NOT_FOUND: HttpStatus.NOT_FOUND,
  CLASS_NOT_FOUND: HttpStatus.NOT_FOUND,
  GROUP_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_DATES: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  YEAR_OVERLAP: HttpStatus.CONFLICT,
  YEAR_NAME_TAKEN: HttpStatus.CONFLICT,
  ACTIVE_YEAR_EXISTS: HttpStatus.CONFLICT,
  YEAR_CLOSED: HttpStatus.CONFLICT,
  INVALID_STATE: HttpStatus.CONFLICT,
  CLASS_EXISTS: HttpStatus.CONFLICT,
  GROUP_EXISTS: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
};

const day = z.string({ error: "Indique a data." }).regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const optionalText = (max: number) => z.string().max(max).nullish();
const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));

const yearCreate = z
  .object({ name: optionalText(40), startsOn: day, endsOn: day, copyFromYearId: z.uuid().nullish() })
  .meta({ title: "AcademicYearCreate", description: "Sem nome, sugere-se a partir das datas (ex.: 2026/2027)." });
const yearUpdate = z.object({ name: z.string().min(1).max(40), startsOn: day, endsOn: day }).meta({ title: "AcademicYearUpdate" });
const classCreate = z
  .object({ grade: z.number().int().min(0).max(13), course: optionalText(80), description: optionalText(160) })
  .meta({ title: "SchoolClassCreate", description: "0 = Iniciação; 1–13 = classe. Curso obrigatório no II Ciclo (10.ª–13.ª) e só aí." });
const groupFields = { shift: z.enum(["MANHA", "TARDE", "NOITE"], { error: "Escolha o turno." }), room: optionalText(40), capacity: z.number().int().min(1).max(200).nullish() };
const groupCreate = z.object({ name: optionalText(20), ...groupFields }).meta({ title: "ClassGroupCreate", description: "Sem nome, usa-se a próxima letra livre (A, B, C…)." });
const groupUpdate = z.object({ name: z.string().min(1).max(20), ...groupFields }).meta({ title: "ClassGroupUpdate" });

const actorOf = (u: SchoolAccess): PedagogyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Área pedagógica do colégio: ano letivo → classes → turmas.
 * Ver: qualquer utilizador do colégio. Alterar: direção/responsável (o suporte
 * em só leitura é travado pelo SchoolAuthGuard em qualquer pedido que não seja GET).
 */
@ApiTags("Portal · Pedagógico")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class PedagogyController {
  constructor(private readonly pedagogy: Pedagogy) {}

  private repo(tenant: TenantContext) {
    return new PrismaPedagogyRepository(tenant.db);
  }

  // ---------------------------------------------------------------- anos letivos

  @Get("years")
  @ApiOperation({ summary: "Anos letivos (com nº de classes, turmas e lotação)" })
  years(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.pedagogy.listYears(this.repo(t), actorOf(u));
  }

  @Post("years")
  @ApiOperation({ summary: "Criar ano letivo (início e fim; opcional: copiar classes e turmas de outro ano)" })
  @ApiBody({ schema: openApi(yearCreate) })
  async createYear(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(yearCreate)) body: z.infer<typeof yearCreate>) {
    return unwrap(await this.pedagogy.createYear(this.repo(t), actorOf(u), body), HTTP);
  }

  @Get("years/:id")
  @ApiOperation({ summary: "Ano letivo com as classes e turmas" })
  async year(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.pedagogy.year(this.repo(t), actorOf(u), yearId), HTTP);
  }

  @Patch("years/:id")
  @ApiOperation({ summary: "Alterar nome e datas (não num ano encerrado)" })
  @ApiBody({ schema: openApi(yearUpdate) })
  async updateYear(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(yearUpdate)) body: z.infer<typeof yearUpdate>) {
    return unwrap(await this.pedagogy.updateYear(this.repo(t), actorOf(u), yearId, body), HTTP);
  }

  @Post("years/:id/activate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Ativar (só um ano em curso)" })
  async activate(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.pedagogy.activate(this.repo(t), actorOf(u), yearId), HTTP);
  }

  @Post("years/:id/close")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Encerrar (fica só de leitura)" })
  async close(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.pedagogy.close(this.repo(t), actorOf(u), yearId), HTTP);
  }

  @Delete("years/:id")
  @ApiOperation({ summary: "Eliminar (só a preparar e sem classes)" })
  async deleteYear(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.pedagogy.deleteYear(this.repo(t), actorOf(u), yearId), HTTP);
  }

  // ---------------------------------------------------------------- classes

  @Post("years/:id/classes")
  @ApiOperation({ summary: "Acrescentar uma classe ao ano letivo" })
  @ApiBody({ schema: openApi(classCreate) })
  async addClass(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(classCreate)) body: z.infer<typeof classCreate>) {
    return unwrap(await this.pedagogy.addClass(this.repo(t), actorOf(u), yearId, body), HTTP);
  }

  @Delete("classes/:id")
  @ApiOperation({ summary: "Remover uma classe (sem turmas)" })
  async removeClass(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) classId: string) {
    return unwrap(await this.pedagogy.removeClass(this.repo(t), actorOf(u), classId), HTTP);
  }

  // ---------------------------------------------------------------- turmas

  @Post("classes/:id/groups")
  @ApiOperation({ summary: "Criar turma numa classe" })
  @ApiBody({ schema: openApi(groupCreate) })
  async addGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) classId: string, @Body(new ZodValidationPipe(groupCreate)) body: z.infer<typeof groupCreate>) {
    return unwrap(await this.pedagogy.addGroup(this.repo(t), actorOf(u), classId, body), HTTP);
  }

  @Patch("groups/:id")
  @ApiOperation({ summary: "Alterar turma (nome, turno, sala, lotação)" })
  @ApiBody({ schema: openApi(groupUpdate) })
  async updateGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string, @Body(new ZodValidationPipe(groupUpdate)) body: z.infer<typeof groupUpdate>) {
    return unwrap(await this.pedagogy.updateGroup(this.repo(t), actorOf(u), groupId, body), HTTP);
  }

  @Delete("groups/:id")
  @ApiOperation({ summary: "Remover turma" })
  async removeGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    return unwrap(await this.pedagogy.removeGroup(this.repo(t), actorOf(u), groupId), HTTP);
  }
}
