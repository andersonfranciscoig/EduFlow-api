import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { openApi } from "../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../../tenancy/tenant-context";
import { ManageUsers } from "../../application/ManageUsers";
import type { SchoolAccess } from "../../application/ports";
import { PrismaUserAdminRepository } from "../../infrastructure/user-admin-repository";
import { orThrow } from "./http-support";
import { CurrentUser, NoSupport, SchoolAuthGuard } from "./school-auth";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const permissions = z.array(z.string().max(60)).max(40);
const inviteBody = z
  .object({ fullName: z.string().min(3).max(120), email: z.string().max(254), role: z.enum(["DIRETOR", "SECRETARIA", "PROFESSOR"]), permissions })
  .meta({ title: "UserInvite", description: "Convida um utilizador: fica por ativar até entrar no portal com o email (código → senha → 2FA)." });
const updateBody = z
  .object({ role: z.enum(["DIRETOR", "SECRETARIA", "PROFESSOR"]), permissions })
  .meta({ title: "UserAccess", description: "Papel e permissões (substitui as atuais). Qualquer permissão do RH inclui hr.access." });

/**
 * Utilizadores do portal do colégio e as suas permissões.
 * Só o RESPONSÁVEL do colégio — e nunca numa sessão de suporte EduFlow.
 */
@ApiTags("Portal · Utilizadores")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/users")
@UseGuards(TenantGuard, SchoolAuthGuard)
@NoSupport()
export class UsersController {
  constructor(private readonly users: ManageUsers) {}

  private repo(t: TenantContext) {
    return new PrismaUserAdminRepository(t.db);
  }

  private school(t: TenantContext) {
    return { slug: t.entry.slug, name: t.entry.schoolName };
  }

  @Get()
  @ApiOperation({ summary: "Utilizadores, papéis e permissões (com o catálogo de permissões)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return orThrow(await this.users.list(this.repo(t), u));
  }

  @Post()
  @ApiOperation({ summary: "Convidar utilizador (envia email; uma falha no email não impede o convite)" })
  @ApiBody({ schema: openApi(inviteBody) })
  async invite(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(inviteBody)) body: z.infer<typeof inviteBody>) {
    return orThrow(await this.users.invite(this.repo(t), u, this.school(t), body));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Alterar papel e permissões" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) userId: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return orThrow(await this.users.update(this.repo(t), u, userId, body));
  }

  @Post(":id/suspend")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Suspender (termina as sessões abertas)" })
  async suspend(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) userId: string) {
    return orThrow(await this.users.suspend(this.repo(t), u, userId));
  }

  @Post(":id/reactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reativar uma conta suspensa" })
  async reactivate(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) userId: string) {
    return orThrow(await this.users.reactivate(this.repo(t), u, userId));
  }

  @Post(":id/resend-invite")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reenviar o email de convite (conta por ativar)" })
  async resend(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) userId: string) {
    return orThrow(await this.users.resendInvite(this.repo(t), u, this.school(t), userId));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Cancelar um convite por ativar" })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) userId: string) {
    return orThrow(await this.users.cancelInvite(this.repo(t), u, userId));
  }
}
