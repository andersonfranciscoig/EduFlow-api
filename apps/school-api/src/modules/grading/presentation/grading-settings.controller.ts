import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { type GradingActor, GradingModels } from "../application/GradingModels";
import { GradingRules, MAX_SCOPES } from "../application/GradingRules";
import type { GradingErrorCode } from "../domain/model";
import { PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";

export const GRADING_HTTP: Partial<Record<GradingErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  INCOMPLETE: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  NAME_TAKEN: HttpStatus.CONFLICT,
  CHANGED: HttpStatus.CONFLICT,
  IN_USE: HttpStatus.CONFLICT,
  NEEDS_CONFIRMATION: HttpStatus.CONFLICT,
  YEAR_CLOSED: HttpStatus.CONFLICT,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const key = z.string().regex(/^[a-z0-9-]{1,40}$/, "Chave inválida.");
const num = z.number().finite();
const weight = num.nullable();
const definition = z.object({
  kind: z.enum(["NUMERIC", "MIXED", "QUALITATIVE"]),
  scale: z.object({ min: num, max: num, pass: num }),
  descriptive: z.enum(["NONE", "OPTIONAL", "REQUIRED"]),
  levels: z.array(z.object({ key, label: z.string().max(60), from: num.nullable(), positive: z.boolean() })).max(20),
  weighting: z.enum(["PERCENT", "EQUAL"]),
  components: z
    .array(
      z.object({
        key,
        name: z.string().max(100),
        source: z.enum(["CONTINUOUS", "TEACHER_TEST", "TERM_TEST", "OTHER"]),
        weight,
        aggregation: z.enum(["MEAN", "WEIGHTED", "BY_TYPE", "BEST"]),
        minItems: z.number().int(),
        maxItems: z.number().int().nullable(),
        parts: z.array(z.object({ typeId: z.uuid(), weight })).max(40),
      }),
    )
    .max(20),
  decimals: z.object({ mark: z.number().int(), period: z.number().int(), final: z.number().int() }),
  rounding: z.enum(["HALF_UP", "DOWN"]),
  absences: z.object({ unjustified: z.enum(["ZERO", "EXCLUDE"]), justified: z.enum(["PENDING", "EXCLUDE"]) }),
  periodWeights: z.array(weight).max(6).nullable(),
  exam: z.object({ enabled: z.boolean(), frequencyWeight: weight, examWeight: weight, minFrequency: num.nullable(), waiveFrom: num.nullable(), parts: z.array(z.object({ key, name: z.string().max(80), weight })).max(10) }),
  recovery: z.object({ enabled: z.boolean(), minMark: num.nullable(), maxSubjects: z.number().int().nullable(), result: z.enum(["REPLACE", "BEST", "MEAN"]) }),
});
const createBody = z.object({ name: z.string().max(200), preset: z.string().max(40).nullish(), copyOf: z.uuid().nullish() }).meta({ title: "GradingModelCreate", description: "A partir de um modelo sugerido (preset) ou da cópia de um do colégio (copyOf)." });
const revision = z.number().int().min(1);
const draftBody = z.object({ revision, name: z.string().max(200), description: z.string().max(600).nullish(), definition }).meta({ title: "GradingModelDraft", description: "O rascunho pode estar incompleto; a resposta diz o que falta para publicar." });
const publishBody = z.object({ revision, reason: z.string().max(400).nullish(), confirm: z.boolean().nullish() }).meta({ title: "GradingModelPublish" });
const typesBody = z.object({ names: z.array(z.string().max(100)).min(1).max(40) }).meta({ title: "GradingTypes" });
const nameBody = z.object({ name: z.string().max(100) }).meta({ title: "GradingTypeName" });
const scope = z.object({
  level: z.enum(["pre", "primario", "ciclo1", "ciclo2"]).nullable().default(null),
  courseId: z.uuid().nullable().default(null),
  classId: z.uuid().nullable().default(null),
  subjectId: z.uuid().nullable().default(null),
  period: z.number().int().min(1).max(3).nullable().default(null),
});
const rulesBody = z.object({ modelId: z.uuid().nullable(), scopes: z.array(scope).min(1).max(MAX_SCOPES) }).meta({ title: "GradingRules", description: "Onde se aplica um modelo (todo o colégio, ensino, curso ou classe; com ou sem disciplina e período). modelId null = volta a herdar." });
const copyBody = z.object({ fromYearId: z.uuid() }).meta({ title: "GradingRulesCopy" });
const yearQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional() }));
const revisionQuery = new ZodValidationPipe(z.object({ revision: z.coerce.number().int().min(1) }));

/** Critérios de avaliação do colégio. Ver: grading.access · configurar: grading.settings.manage. */
@ApiTags("Portal · Avaliação · Critérios")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/grading")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class GradingSettingsController {
  constructor(
    private readonly models: GradingModels,
    private readonly rules: GradingRules,
  ) {}
  private repo(t: TenantContext) {
    return PrismaGradingSettingsRepository.for(t.db);
  }
  private async actor(t: TenantContext, u: SchoolAccess): Promise<GradingActor> {
    return { id: u.support ? null : u.id, canManage: (await permissionsOf(t.db, u)).includes("grading.settings.manage") };
  }

  // ---------------------------------------------------------------- modelos

  @Get("models")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Modelos do colégio, modelos sugeridos e elementos de avaliação" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.models.overview(this.repo(t), await this.actor(t, u));
  }

  @Post("models")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Criar um modelo (em preparação)" })
  @ApiBody({ schema: openApi(createBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return unwrap(await this.models.create(this.repo(t), await this.actor(t, u), body), GRADING_HTTP);
  }

  @Get("models/:id")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Um modelo: o que está a ser editado, o que falta, as versões, onde se aplica e o histórico" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string) {
    return unwrap(await this.models.detail(this.repo(t), await this.actor(t, u), modelId), GRADING_HTTP);
  }

  @Put("models/:id/draft")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Gravar o rascunho (mesmo incompleto)" })
  @ApiBody({ schema: openApi(draftBody) })
  async saveDraft(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string, @Body(new ZodValidationPipe(draftBody)) body: z.infer<typeof draftBody>) {
    return unwrap(await this.models.saveDraft(this.repo(t), await this.actor(t, u), modelId, body), GRADING_HTTP);
  }

  @Delete("models/:id/draft")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Deitar fora as alterações por publicar (?revision=)" })
  async discard(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string, @Query(revisionQuery) q: { revision: number }) {
    return unwrap(await this.models.discardDraft(this.repo(t), await this.actor(t, u), modelId, q.revision), GRADING_HTTP);
  }

  @Post("models/:id/publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Publicar uma versão (pesos a 100%; em uso pede confirmação; da 2.ª em diante, motivo)" })
  @ApiBody({ schema: openApi(publishBody) })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string, @Body(new ZodValidationPipe(publishBody)) body: z.infer<typeof publishBody>) {
    return unwrap(await this.models.publish(this.repo(t), await this.actor(t, u), modelId, body), GRADING_HTTP);
  }

  @Delete("models/:id")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Apagar (nunca publicado) ou arquivar um modelo" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string) {
    return unwrap(await this.models.remove(this.repo(t), await this.actor(t, u), modelId), GRADING_HTTP);
  }

  @Post("models/:id/restore")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Voltar a usar um modelo arquivado" })
  async restore(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) modelId: string) {
    return unwrap(await this.models.restore(this.repo(t), await this.actor(t, u), modelId), GRADING_HTTP);
  }

  // ---------------------------------------------------------------- elementos de avaliação

  @Post("types")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Juntar elementos de avaliação" })
  @ApiBody({ schema: openApi(typesBody) })
  async addTypes(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(typesBody)) body: { names: string[] }) {
    return unwrap(await this.models.addTypes(this.repo(t), await this.actor(t, u), body.names), GRADING_HTTP);
  }

  @Patch("types/:id")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Mudar o nome de um elemento" })
  @ApiBody({ schema: openApi(nameBody) })
  async renameType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string, @Body(new ZodValidationPipe(nameBody)) body: { name: string }) {
    return unwrap(await this.models.renameType(this.repo(t), await this.actor(t, u), typeId, body.name), GRADING_HTTP);
  }

  @Delete("types/:id")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Apagar um elemento (arquiva-se se algum modelo o usa)" })
  async removeType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string) {
    return unwrap(await this.models.removeType(this.repo(t), await this.actor(t, u), typeId), GRADING_HTTP);
  }

  @Post("types/:id/restore")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Voltar a usar um elemento arquivado" })
  async restoreType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string) {
    return unwrap(await this.models.restoreType(this.repo(t), await this.actor(t, u), typeId), GRADING_HTTP);
  }

  // ---------------------------------------------------------------- onde se aplica

  @Get("rules")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Que modelo se aplica a cada classe e disciplina (?ano=), com herança, e o que falta" })
  async rulesOf(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(yearQuery) q: { ano?: string }) {
    return this.rules.overview(this.repo(t), await this.actor(t, u), q.ano);
  }

  @Put("years/:yearId/rules")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Aplicar um modelo (ou voltar a herdar) a um ou vários sítios" })
  @ApiBody({ schema: openApi(rulesBody) })
  async setRules(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("yearId", id) yearId: string, @Body(new ZodValidationPipe(rulesBody)) body: z.infer<typeof rulesBody>) {
    return unwrap(await this.rules.set(this.repo(t), await this.actor(t, u), yearId, body), GRADING_HTTP);
  }

  @Post("years/:yearId/rules/copy")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Começar como outro ano letivo (só num ano ainda sem modelos aplicados)" })
  @ApiBody({ schema: openApi(copyBody) })
  async copy(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("yearId", id) yearId: string, @Body(new ZodValidationPipe(copyBody)) body: { fromYearId: string }) {
    return unwrap(await this.rules.copy(this.repo(t), await this.actor(t, u), yearId, body.fromYearId), GRADING_HTTP);
  }
}
