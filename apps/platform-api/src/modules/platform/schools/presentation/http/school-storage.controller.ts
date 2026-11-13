import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { StaffAccess } from "../../../identity/application/ports";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { SchoolStorage } from "../../application/SchoolStorage";
import type { StorageErrorCode } from "../../domain/storage";

const STORAGE_HTTP: Partial<Record<StorageErrorCode, HttpStatus>> = {
  SCHOOL_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_TOKEN: HttpStatus.UNPROCESSABLE_ENTITY,
  TOKEN_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  APP_IN_USE: HttpStatus.CONFLICT,
  NOT_CONFIGURED: HttpStatus.NOT_FOUND,
  KEY_MISSING: HttpStatus.SERVICE_UNAVAILABLE,
  STORAGE_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
};
const uuid = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const tokenBody = z.object({ token: z.string().min(1).max(4000) }).meta({ title: "SchoolStorageToken", description: "Token V7 da app do UploadThing do colégio (API Keys → V7)." });

/**
 * Armazenamento de ficheiros de cada colégio (a SUA app do UploadThing).
 * Ver: schools.view · configurar/trocar/remover: schools.manage com 2FA recente.
 * O token nunca sai da API (nem para o painel): só o id da app e uma pista da chave.
 */
@ApiTags("Plataforma · Colégios · Armazenamento")
@ApiBearerAuth()
@Controller("v1/platform/school-storage")
export class SchoolStorageController {
  constructor(private readonly storage: SchoolStorage) {}

  @Get()
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Armazenamento de todos os colégios (por id): plano, uso e limite" })
  summaries() {
    return this.storage.summaries();
  }

  @Get(":schoolId")
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Armazenamento de um colégio (null = por configurar)" })
  async get(@Param("schoolId", uuid) schoolId: string) {
    return unwrap(await this.storage.get(schoolId), STORAGE_HTTP);
  }

  @Put(":schoolId")
  @StaffAuth("schools.manage")
  @RequireRecentMfa()
  @Throttle({ default: { limit: 10, ttl: 15 * 60_000 } })
  @ApiOperation({ summary: "Ligar (ou trocar) a app do UploadThing do colégio (2FA recente)", description: "O token é confirmado junto do UploadThing antes de ficar guardado." })
  @ApiBody({ schema: openApi(tokenBody) })
  async configure(@Param("schoolId", uuid) schoolId: string, @Body(new ZodValidationPipe(tokenBody)) body: z.infer<typeof tokenBody>, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.storage.configure(schoolId, staff.id, body.token), STORAGE_HTTP);
  }

  @Post(":schoolId/refresh")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.view")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Medir de novo o uso (bytes, ficheiros, limite → plano grátis ou pago)" })
  async refresh(@Param("schoolId", uuid) schoolId: string) {
    return unwrap(await this.storage.refresh(schoolId), STORAGE_HTTP);
  }

  @Delete(":schoolId")
  @StaffAuth("schools.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Desligar a app (2FA recente): os envios de ficheiros do colégio ficam bloqueados" })
  async remove(@Param("schoolId", uuid) schoolId: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.storage.remove(schoolId, staff.id), STORAGE_HTTP);
  }
}
