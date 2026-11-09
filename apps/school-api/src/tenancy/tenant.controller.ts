import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentTenant, type TenantContext, TenantGuard } from "./tenant-context";

@ApiTags("Colégio")
@Controller("v1/tenant")
@UseGuards(TenantGuard)
@ApiHeader({ name: "X-Tenant", required: false, description: "Slug do colégio (em produção vem do subdomínio)" })
export class TenantController {
  @Get()
  @ApiOperation({
    summary: "Identidade do colégio",
    description: "Lida da base de dados PRÓPRIA do colégio, com o utilizador PostgreSQL do próprio colégio.",
  })
  async info(@CurrentTenant() tenant: TenantContext) {
    const info = await tenant.db.tenantInfo.findUnique({ where: { id: 1 } });
    return {
      slug: tenant.entry.slug,
      name: info?.name ?? tenant.entry.schoolName,
      database: { name: tenant.entry.dbName, user: tenant.entry.dbUser, connected: !!info },
    };
  }
}
