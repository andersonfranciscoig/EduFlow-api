import { Injectable } from "@nestjs/common";
import type { TenantContext } from "../../../tenancy/tenant-context";
import type { TenantScope } from "../application/ports";
import { PrismaEmailCodeRepository, PrismaSchoolSessionRepository, PrismaSchoolUserRepository } from "./prisma-repositories";
import { PrismaSupportRepository } from "./support-repository";

/**
 * Liga os repositórios à BD do colégio do pedido. Objetos leves (sem estado
 * além do cliente Prisma do colégio, que vem do pool de TenantConnections).
 */
@Injectable()
export class TenantScopes {
  for(tenant: TenantContext): TenantScope {
    return {
      schoolId: tenant.entry.schoolId,
      slug: tenant.entry.slug,
      schoolName: tenant.entry.schoolName,
      users: new PrismaSchoolUserRepository(tenant.db),
      sessions: new PrismaSchoolSessionRepository(tenant.db),
      codes: new PrismaEmailCodeRepository(tenant.db),
      support: new PrismaSupportRepository(tenant.db),
    };
  }
}
