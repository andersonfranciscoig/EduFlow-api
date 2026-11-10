import { Global, Module } from "@nestjs/common";
import { TenantConnections } from "./tenant-connections";
import { TenantGuard } from "./tenant-context";
import { TenantController } from "./tenant.controller";
import { TenantDirectory } from "./tenant-directory";

/**
 * Resolução do colégio de cada pedido + ligações às BDs dos colégios.
 * Global: todos os contextos do portal usam o mesmo pool e o mesmo guard.
 */
@Global()
@Module({
  controllers: [TenantController],
  providers: [TenantDirectory, TenantConnections, TenantGuard],
  exports: [TenantDirectory, TenantConnections, TenantGuard],
})
export class TenancyModule {}
