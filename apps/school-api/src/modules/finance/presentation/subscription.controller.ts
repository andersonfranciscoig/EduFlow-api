import { Controller, Get, Logger, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { TenantDirectory } from "../../../tenancy/tenant-directory";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";

const DAY = 86_400_000;

/** A subscrição do colégio à EduFlow (só o responsável e a direção veem quando termina). */
@ApiTags("Portal · Subscrição")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/subscription")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class SubscriptionController {
  private readonly logger = new Logger("Subscription");

  constructor(private readonly directory: TenantDirectory) {}

  @Get()
  @ApiOperation({ summary: "Quando termina a subscrição (null = não se sabe, ou não é da direção)" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    if (u.support || (!u.isOwner && u.role !== "DIRETOR")) return { endsAt: null, daysLeft: null };
    try {
      const [r] = await this.directory.platform.$queryRaw<{ ends: Date | null }[]>`SELECT subscription_ends_at AS ends FROM schools WHERE id = ${t.entry.schoolId}::uuid`;
      return { endsAt: r?.ends?.toISOString() ?? null, daysLeft: r?.ends ? Math.ceil((r.ends.getTime() - Date.now()) / DAY) : null };
    } catch (e) {
      this.logger.warn(`fim da subscrição indisponível: ${(e as Error).message.split("\n").pop()}`);
      return { endsAt: null, daysLeft: null };
    }
  }
}
