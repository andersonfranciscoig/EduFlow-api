import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { apiErrorSchema, openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { StaffAccess } from "../../application/ports";
import {
  ActivateStaffMember,
  ChangeStaffRole,
  ResetStaffMfa,
  SetStaffPermissions,
  SuspendStaffMember,
} from "../../application/use-cases/staff/ManageStaffMember";
import { StaffSecurity } from "../../application/use-cases/StaffSecurity";
import { GetStaffActivity, GetStaffMember, ListStaffMembers } from "../../application/use-cases/staff/QueryStaff";
import { PERMISSION_CATALOG, STAFF_ROLES, STAFF_STATUSES } from "../../domain/access-control";
import { toHttpException } from "./identity-http-error";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "./staff-auth";
import {
  type ActivityQuery,
  activityQuerySchema,
  activityResponseSchema,
  type ChangeRoleBody,
  changeRoleSchema,
  type ListStaffQuery,
  listStaffQuerySchema,
  memberIdSchema,
  permissionCatalogSchema,
  type SetPermissionsBody,
  setPermissionsSchema,
  staffDetailSchema,
  staffListResponseSchema,
} from "./staff.schemas";

const error = openApi(apiErrorSchema);
const detail = openApi(staffDetailSchema, "output");
const idParam = new ZodValidationPipe(memberIdSchema);

/**
 * Gestão da equipa interna (membros, papéis, permissões, histórico).
 * Leitura exige `staff.view`; alterações exigem `staff.manage`.
 * As regras finas (último admin, não se gerir a si próprio…) vêm do domínio.
 */
@ApiTags("Plataforma · Equipa")
@ApiBearerAuth()
@ApiResponse({ status: 401, description: "Sessão inválida ou expirada", schema: error })
@ApiResponse({ status: 403, description: "Sem permissão", schema: error })
@Controller("v1/platform/staff")
export class StaffController {
  constructor(
    private readonly listStaff: ListStaffMembers,
    private readonly getMember: GetStaffMember,
    private readonly getActivity: GetStaffActivity,
    private readonly activateMember: ActivateStaffMember,
    private readonly suspendMember: SuspendStaffMember,
    private readonly changeRole: ChangeStaffRole,
    private readonly setPermissions: SetStaffPermissions,
    private readonly resetMfa: ResetStaffMfa,
    private readonly security: StaffSecurity,
  ) {}

  @Get()
  @StaffAuth("staff.view")
  @ApiOperation({ summary: "Listar membros da equipa", description: "Com contagens por estado." })
  @ApiQuery({ name: "status", required: false, enum: STAFF_STATUSES })
  @ApiQuery({ name: "role", required: false, enum: STAFF_ROLES })
  @ApiResponse({ status: 200, description: "Lista", schema: openApi(staffListResponseSchema, "output") })
  list(@Query(new ZodValidationPipe(listStaffQuerySchema)) query: ListStaffQuery) {
    return this.listStaff.execute(query);
  }

  @Get("permissions")
  @StaffAuth()
  @ApiOperation({ summary: "Catálogo de permissões", description: "Todas as permissões que podem ser atribuídas." })
  @ApiResponse({ status: 200, description: "Catálogo", schema: openApi(permissionCatalogSchema, "output") })
  catalog() {
    return PERMISSION_CATALOG;
  }

  @Get(":id")
  @StaffAuth("staff.view")
  @ApiOperation({ summary: "Perfil de um membro" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 200, description: "Perfil", schema: detail })
  @ApiResponse({ status: 404, description: "Membro não encontrado", schema: error })
  async detail(@Param("id", idParam) id: string) {
    const result = await this.getMember.execute({ id });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Get(":id/activity")
  @StaffAuth("staff.view")
  @ApiOperation({
    summary: "Histórico de atividade",
    description: "Ações feitas pelo membro e ações feitas sobre ele, da mais recente para a mais antiga.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "before", required: false, description: "ISO 8601 — paginação" })
  @ApiResponse({ status: 200, description: "Histórico", schema: openApi(activityResponseSchema, "output") })
  async activity(
    @Param("id", idParam) id: string,
    @Query(new ZodValidationPipe(activityQuerySchema)) query: ActivityQuery,
  ) {
    const result = await this.getActivity.execute({ id, ...query });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("staff.manage")
  @ApiOperation({ summary: "Aprovar / reativar conta" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 200, description: "Perfil atualizado", schema: detail })
  @ApiResponse({ status: 409, description: "A conta já está ativa", schema: error })
  async activate(@Param("id", idParam) id: string, @CurrentStaff() actor: StaffAccess) {
    const result = await this.activateMember.execute({ actorId: actor.id, memberId: id });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post(":id/suspend")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Desativar conta", description: "Termina todas as sessões do membro. Exige 2FA recente." })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 200, description: "Perfil atualizado", schema: detail })
  @ApiResponse({ status: 409, description: "Já desativada, ou é o último administrador", schema: error })
  async suspend(@Param("id", idParam) id: string, @CurrentStaff() actor: StaffAccess) {
    const result = await this.suspendMember.execute({ actorId: actor.id, memberId: id });
    if (!result.ok) throw toHttpException(result.error);
    await this.security.revokeMemberSessions(actor.id, id, "Conta desativada");
    return result.value;
  }

  @Get(":id/security")
  @StaffAuth("staff.view")
  @ApiOperation({ summary: "Segurança do membro: 2FA e sessões ativas" })
  @ApiParam({ name: "id", format: "uuid" })
  async memberSecurity(@Param("id", idParam) id: string) {
    const result = await this.security.memberSecurity(id);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post(":id/mfa/reset")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({
    summary: "Repor a 2FA",
    description: "Para quem perdeu o telemóvel: termina as sessões e obriga a configurar a 2FA no próximo login. Exige 2FA recente.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  async resetMemberMfa(@Param("id", idParam) id: string, @CurrentStaff() actor: StaffAccess) {
    const result = await this.resetMfa.execute({ actorId: actor.id, memberId: id });
    if (!result.ok) throw toHttpException(result.error);
    await this.security.revokeMemberSessions(actor.id, id, "2FA reposta");
    return result.value;
  }

  @Post(":id/sessions/revoke")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Terminar todas as sessões do membro", description: "Exige 2FA recente." })
  @ApiParam({ name: "id", format: "uuid" })
  async revokeMemberSessions(@Param("id", idParam) id: string, @CurrentStaff() actor: StaffAccess) {
    if (id === actor.id) {
      throw toHttpException({ code: "CANNOT_MANAGE_SELF", message: "Use a página da sua conta para terminar as suas sessões." } as never);
    }
    const result = await this.security.revokeMemberSessions(actor.id, id);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Patch(":id/role")
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Alterar papel", description: "Só administradores. Nunca pode ficar sem admins ativos." })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: openApi(changeRoleSchema) })
  @ApiResponse({ status: 200, description: "Perfil atualizado", schema: detail })
  async role(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: ChangeRoleBody,
    @CurrentStaff() actor: StaffAccess,
  ) {
    const result = await this.changeRole.execute({ actorId: actor.id, memberId: id, role: body.role });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Put(":id/permissions")
  @StaffAuth("staff.manage")
  @RequireRecentMfa()
  @ApiOperation({
    summary: "Definir permissões extra",
    description: "Substitui as permissões atribuídas individualmente a um gestor (as do papel mantêm-se).",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: openApi(setPermissionsSchema) })
  @ApiResponse({ status: 200, description: "Perfil atualizado", schema: detail })
  @ApiResponse({ status: 422, description: "Permissão desconhecida", schema: error })
  async permissions(
    @Param("id", idParam) id: string,
    @Body(new ZodValidationPipe(setPermissionsSchema)) body: SetPermissionsBody,
    @CurrentStaff() actor: StaffAccess,
  ) {
    const result = await this.setPermissions.execute({ actorId: actor.id, memberId: id, permissions: body.permissions });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }
}
