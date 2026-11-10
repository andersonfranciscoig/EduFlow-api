import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { CurrentTenant, type TenantContext, TenantGuard } from "./tenant-context";

@ApiTags("Colégio")
@Controller("v1/tenant")
@UseGuards(TenantGuard)
@ApiHeader({ name: "X-Tenant", required: false, description: "Slug do colégio (enviado pelo servidor do portal)" })
export class TenantController {
  @Get()
  @SkipThrottle()
  @ApiOperation({
    summary: "Identidade pública do colégio",
    description:
      "Nome e slug, lidos da BD PRÓPRIA do colégio (com o utilizador PostgreSQL do colégio). " +
      "Rota pública: não expõe nada sobre a infraestrutura (servidor, BD, utilizador).",
  })
  async info(@CurrentTenant() tenant: TenantContext) {
    const info = await tenant.db.tenantInfo.findUnique({ where: { id: 1 }, select: { name: true } });
    return { slug: tenant.entry.slug, name: info?.name ?? tenant.entry.schoolName };
  }
}
