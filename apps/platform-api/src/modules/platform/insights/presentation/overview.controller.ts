import { Controller, Get, Header } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { StaffAccess } from "../../identity/application/ports";
import { CurrentStaff, StaffAuth } from "../../identity/presentation/http/staff-auth";
import { PlatformOverview } from "../application/PlatformOverview";

@ApiTags("Plataforma · Visão geral")
@ApiBearerAuth()
@Controller("v1/platform/overview")
export class OverviewController {
  constructor(private readonly overview: PlatformOverview) {}

  @Get()
  @StaffAuth()
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Números e séries da visão geral do painel",
    description:
      "Colégios, faturação, equipa e bases de dados — cada secção só vem preenchida com a permissão de ver dessa área (`schools.view`, `billing.view`, `staff.view`, `databases.view`); sem ela, `null`. `access` (o próprio acesso) vem sempre. Meses e dias em hora de Luanda.",
  })
  get(@CurrentStaff() staff: StaffAccess) {
    return this.overview.execute(staff);
  }
}
