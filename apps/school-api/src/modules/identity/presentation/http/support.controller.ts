import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { openApi } from "../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../application/ports";
import { SupportAccess } from "../../application/SupportAccess";
import { TenantScopes } from "../../infrastructure/tenant-scopes";
import { supportGrantSchema } from "./auth.schemas";
import { orThrow } from "./http-support";
import { CurrentUser, NoSupport, SchoolAuthGuard } from "./school-auth";

/**
 * O colégio decide se a equipa EduFlow pode entrar (e até quando) e vê cada
 * entrada. Só o diretor/responsável — e NUNCA uma sessão de suporte.
 */
@ApiTags("Portal · Suporte EduFlow")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/support/access")
// numa só chamada e por esta ordem: primeiro o colégio (TenantGuard), depois a sessão
@UseGuards(TenantGuard, SchoolAuthGuard)
@ApiBearerAuth()
@NoSupport()
export class SupportAccessController {
  constructor(
    private readonly support: SupportAccess,
    private readonly scopes: TenantScopes,
  ) {}

  @Get()
  @ApiOperation({ summary: "Autorização atual e entradas recentes do suporte" })
  async status(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: SchoolAccess) {
    return orThrow(await this.support.status(this.scopes.for(tenant), user));
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: "Autorizar o suporte EduFlow durante 1, 7 ou 30 dias", description: "Substitui uma autorização anterior." })
  @ApiBody({ schema: openApi(supportGrantSchema) })
  async grant(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: SchoolAccess, @Body(new ZodValidationPipe(supportGrantSchema)) body: { days: number }) {
    return orThrow(await this.support.grant(this.scopes.for(tenant), user, body.days));
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Retirar o acesso do suporte (termina já as sessões em curso)" })
  async revoke(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: SchoolAccess) {
    return orThrow(await this.support.revoke(this.scopes.for(tenant), user));
  }
}
