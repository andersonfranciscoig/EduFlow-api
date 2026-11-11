import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { StaffAccess } from "../../../identity/application/ports";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { DatabaseBackups } from "../../application/DatabaseBackups";
import { DatabasePlacement } from "../../application/DatabasePlacement";
import { DatabaseRegistry } from "../../application/DatabaseRegistry";
import {
  assignSchema,
  DATABASE_HTTP,
  type RegisterServerBody,
  registerServerSchema,
  reserveSchema,
  rotateCredentialsSchema,
  type ServerSettingsBody,
  serverSettingsSchema,
} from "./database.schemas";

const uuid = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const MINUTE = 60_000;

@ApiTags("Plataforma · Bases de dados")
@ApiBearerAuth()
@Controller("v1/platform/databases")
export class DatabaseServersController {
  constructor(private readonly registry: DatabaseRegistry) {}

  @Get()
  @StaffAuth("databases.view")
  @ApiOperation({ summary: "Servidores de BD, ocupação, saúde e latência recente" })
  list() {
    return this.registry.list();
  }

  @Post()
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({
    summary: "Registar servidor partilhado ou BD dedicada",
    description:
      "O URL é validado, cifrado com a chave pública do provisioner e NUNCA devolvido. Fora de localhost exige sslmode=require|verify-ca|verify-full. Cria logo um teste de ligação (checkId). Exige 2FA recente.",
  })
  @ApiBody({ schema: openApi(registerServerSchema) })
  async register(@Body(new ZodValidationPipe(registerServerSchema)) body: RegisterServerBody, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.register(body, staff.id), DATABASE_HTTP);
  }

  @Get(":id")
  @StaffAuth("databases.view")
  @ApiOperation({ summary: "Detalhe: saúde, colégios (reservas/atribuições), testes e histórico" })
  async detail(@Param("id", uuid) id: string) {
    return unwrap(await this.registry.detail(id), DATABASE_HTTP);
  }

  @Patch(":id")
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Alterar nome, capacidade, região e notas (2FA recente)" })
  @ApiBody({ schema: openApi(serverSettingsSchema) })
  async update(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(serverSettingsSchema)) body: ServerSettingsBody, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.updateSettings(id, body, staff.id), DATABASE_HTTP);
  }

  @Put(":id/credentials")
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({
    summary: "Substituir o URL de ligação (2FA recente)",
    description: "Com colégios atribuídos só se pode mudar utilizador/senha. Numa BD dedicada em uso, o diretório do colégio é atualizado pelo provisioner.",
  })
  @ApiBody({ schema: openApi(rotateCredentialsSchema) })
  async rotate(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(rotateCredentialsSchema)) body: { url: string }, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.rotateCredentials(id, body.url, staff.id), DATABASE_HTTP);
  }

  @Post(":id/disable")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Desativar (deixa de receber colégios novos; os atuais continuam)" })
  async disable(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.setEnabled(id, false, staff.id), DATABASE_HTTP);
  }

  @Post(":id/enable")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Reativar" })
  async enable(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.setEnabled(id, true, staff.id), DATABASE_HTTP);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Apagar (só servidores que nunca tiveram colégios)" })
  async remove(@Param("id", uuid) id: string) {
    unwrap(await this.registry.remove(id), DATABASE_HTTP);
  }

  @Post(":id/checks")
  @StaffAuth("databases.view")
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: "Testar a ligação agora", description: "O teste é feito pelo provisioner; consulte o resultado em GET :id/checks/:checkId." })
  async test(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.registry.requestCheck(id, staff.id), DATABASE_HTTP);
  }

  @Get(":id/checks/:checkId")
  @StaffAuth("databases.view")
  @ApiOperation({ summary: "Resultado de um teste de ligação (latência, versão, TLS, permissões)" })
  async check(@Param("id", uuid) id: string, @Param("checkId", uuid) checkId: string) {
    return unwrap(await this.registry.check(id, checkId), DATABASE_HTTP);
  }
}

@ApiTags("Plataforma · Bases de dados")
@ApiBearerAuth()
@Controller("v1/platform/databases")
export class DatabaseBackupsController {
  constructor(private readonly backups: DatabaseBackups) {}

  @Get(":id/backups")
  @StaffAuth("databases.view")
  @ApiOperation({ summary: "Cópias de segurança das BDs dos colégios deste servidor (e a política)" })
  async listForServer(@Param("id", uuid) id: string) {
    return unwrap(await this.backups.forServer(id), DATABASE_HTTP);
  }

  @Post(":id/backups")
  @StaffAuth("databases.manage")
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @ApiOperation({
    summary: "Copiar agora todos os colégios deste servidor",
    description: "As cópias são feitas pelo provisioner (pg_dump), cifradas com AES-256-GCM e só depois enviadas para o armazenamento.",
  })
  async requestForServer(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.backups.requestForServer(id, staff.id), DATABASE_HTTP);
  }

  @Get("backups/school/:schoolId")
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Cópias de segurança da BD de um colégio" })
  listForSchool(@Param("schoolId", uuid) schoolId: string) {
    return this.backups.forSchool(schoolId);
  }

  @Post("backups/school/:schoolId")
  @StaffAuth("databases.manage")
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @ApiOperation({ summary: "Copiar agora a BD de um colégio" })
  async requestForSchool(@Param("schoolId", uuid) schoolId: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.backups.requestForSchool(schoolId, staff.id), DATABASE_HTTP);
  }
}

@ApiTags("Plataforma · Bases de dados")
@ApiBearerAuth()
@Controller("v1/platform/databases")
export class DatabasePlacementController {
  constructor(private readonly placement: DatabasePlacement) {}

  @Get("placement/:schoolId")
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Servidores disponíveis para um colégio (com recomendação) e estado atual" })
  options(@Param("schoolId", uuid) schoolId: string) {
    return this.placement.options(schoolId);
  }

  @Post("placement/:schoolId/reserve")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @ApiOperation({ summary: "Reservar (ou trocar a reserva de) servidor para um colégio por pagar" })
  @ApiBody({ schema: openApi(reserveSchema) })
  async reserve(@Param("schoolId", uuid) schoolId: string, @Body(new ZodValidationPipe(reserveSchema)) body: { serverId: string }, @CurrentStaff() staff: StaffAccess) {
    unwrap(await this.placement.reserve(schoolId, body.serverId, staff.id), DATABASE_HTTP);
    return this.placement.status(schoolId);
  }

  @Post("placement/:schoolId/assign")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Atribuir servidor a um colégio ativo que está à espera (ou cuja criação falhou)" })
  @ApiBody({ schema: openApi(assignSchema) })
  async assign(@Param("schoolId", uuid) schoolId: string, @Body(new ZodValidationPipe(assignSchema)) body: { serverId: string }, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.placement.assign(schoolId, body.serverId, staff.id), DATABASE_HTTP);
  }

  @Post("allocations/:allocationId/release")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth("databases.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Libertar uma reserva (as atribuições não se libertam: os dados vivem lá)" })
  async release(@Param("allocationId", uuid) allocationId: string, @CurrentStaff() staff: StaffAccess) {
    unwrap(await this.placement.releaseAllocation(allocationId, staff.id), DATABASE_HTTP);
  }
}
