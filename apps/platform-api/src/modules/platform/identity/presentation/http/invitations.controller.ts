import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { StaffAccess } from "../../application/ports";
import { StaffInvitations } from "../../application/use-cases/StaffInvitations";
import { type InviteBody, inviteSchema } from "./auth.schemas";
import { STATUS_BY_CODE } from "./identity-http-error";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "./staff-auth";
import { memberIdSchema } from "./staff.schemas";

/** Convites para a equipa — a única forma de alguém criar conta no painel. */
@ApiTags("Plataforma · Equipa")
@ApiBearerAuth()
@Controller("v1/platform/staff-invitations")
export class InvitationsController {
  constructor(private readonly invitations: StaffInvitations) {}

  @Get()
  @StaffAuth("staff.view")
  @ApiOperation({ summary: "Convites pendentes" })
  list() {
    return this.invitations.listPending();
  }

  @Post()
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Convidar para a equipa (2FA recente)", description: "Envia um email com o link para criar a conta (7 dias). Substitui convites anteriores para o mesmo email." })
  @ApiBody({ schema: openApi(inviteSchema) })
  async invite(@Body(new ZodValidationPipe(inviteSchema)) body: InviteBody, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.invitations.invite(body, staff), STATUS_BY_CODE);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth("staff.manage")
  @ApiOperation({ summary: "Cancelar um convite pendente" })
  async revoke(@Param("id", new ZodValidationPipe(memberIdSchema)) id: string) {
    unwrap(await this.invitations.revoke(id), STATUS_BY_CODE);
  }
}
