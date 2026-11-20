import { Body, Controller, Get, HttpStatus, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AttendanceSettings } from "../application/AttendanceSettings";
import type { AttendanceErrorCode } from "../domain/settings";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";

export const ATTENDANCE_HTTP: Partial<Record<AttendanceErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  OCCURRENCE_EXISTS: HttpStatus.CONFLICT,
  NO_CLASSES: HttpStatus.UNPROCESSABLE_ENTITY,
  DEADLINE_PASSED: HttpStatus.CONFLICT,
};

const rulesBody = z
  .object({
    teacherModel: z.enum(["PER_LESSON", "PER_DAY"], { error: "Escolha o modelo." }),
    missingProcedure: z.enum(["MANUAL", "AUTOMATIC"], { error: "Escolha o procedimento." }),
    deadlineMinutes: z.number().int(),
    absenceLimit: z.number().int(),
    consecutiveLimit: z.number().int(),
    timeZone: z.string().min(3).max(60),
    reason: z.string().max(300).nullish(),
  })
  .meta({ title: "AttendanceRules", description: "Regras de assiduidade do colégio. O motivo fica no histórico." });

/** Regras de assiduidade. Ver: attendance.access · alterar: attendance.settings.manage. Professores não. */
@ApiTags("Portal · Assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class AttendanceSettingsController {
  constructor(private readonly settings: AttendanceSettings) {}

  private repo(t: TenantContext) {
    return new PrismaAttendanceSettingsRepository(t.db);
  }

  private async actor(t: TenantContext, u: SchoolAccess) {
    return { id: u.id, canManage: (await permissionsOf(t.db, u)).includes("attendance.settings.manage") };
  }

  @Get("settings")
  @RequirePermission("attendance.access")
  @ApiOperation({ summary: "Regras de assiduidade (com as opções e o histórico de alterações)" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.settings.view(this.repo(t), await this.actor(t, u));
  }

  @Put("settings")
  @RequirePermission("attendance.settings.manage")
  @ApiOperation({ summary: "Alterar as regras de assiduidade" })
  @ApiBody({ schema: openApi(rulesBody) })
  async put(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(rulesBody)) body: z.infer<typeof rulesBody>) {
    return unwrap(await this.settings.update(this.repo(t), await this.actor(t, u), body), ATTENDANCE_HTTP);
  }
}
