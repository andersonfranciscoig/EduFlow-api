import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { PedagogyActor } from "../application/ports";
import { SchoolCalendar } from "../application/SchoolCalendar";
import { PrismaCalendarRepository } from "../infrastructure/prisma-calendar";
import { PEDAGOGY_HTTP } from "./pedagogy.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const periodsBody = z
  .object({ kind: z.enum(["TRIMESTRE", "SEMESTRE"], { error: "Escolha trimestres ou semestres." }), items: z.array(z.object({ startsOn: day, endsOn: day })).min(2).max(3) })
  .meta({ title: "AcademicPeriods", description: "Divide o ano: 3 trimestres ou 2 semestres, por ordem, dentro do ano e sem se sobreporem (substitui os atuais)." });
const closureBody = z
  .object({ startsOn: day, endsOn: day.nullish(), kind: z.enum(["FERIADO", "PAUSA", "OUTRO"], { error: "Escolha o tipo." }), reason: z.string().max(120) })
  .meta({ title: "SchoolClosure", description: "Dias sem aulas (um dia ou um intervalo) dentro do ano letivo; não se sobrepõem." });

const actorOf = (u: SchoolAccess): PedagogyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/** Calendário escolar: períodos de avaliação e dias sem aulas. Ver: a gestão. Alterar: a direção. */
@ApiTags("Portal · Pedagógico")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class CalendarController {
  constructor(private readonly calendar: SchoolCalendar) {}

  private repo(t: TenantContext) {
    return new PrismaCalendarRepository(t.db);
  }

  @Get("years/:id/calendar")
  @ApiOperation({ summary: "Calendário do ano: períodos de avaliação (e sugestão), período atual e dias sem aulas" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.calendar.calendar(this.repo(t), actorOf(u), yearId), PEDAGOGY_HTTP);
  }

  @Put("years/:id/periods")
  @ApiOperation({ summary: "Definir os períodos de avaliação (trimestres ou semestres)" })
  @ApiBody({ schema: openApi(periodsBody) })
  async periods(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(periodsBody)) body: z.infer<typeof periodsBody>) {
    return unwrap(await this.calendar.setPeriods(this.repo(t), actorOf(u), yearId, body), PEDAGOGY_HTTP);
  }

  @Post("years/:id/closures")
  @ApiOperation({ summary: "Marcar dias sem aulas (feriado, pausa letiva, outro)" })
  @ApiBody({ schema: openApi(closureBody) })
  async addClosure(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(closureBody)) body: z.infer<typeof closureBody>) {
    return unwrap(await this.calendar.addClosure(this.repo(t), actorOf(u), yearId, body), PEDAGOGY_HTTP);
  }

  @Delete("closures/:id")
  @ApiOperation({ summary: "Retirar dias sem aulas" })
  async removeClosure(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) closureId: string) {
    return unwrap(await this.calendar.removeClosure(this.repo(t), actorOf(u), closureId), PEDAGOGY_HTTP);
  }
}
