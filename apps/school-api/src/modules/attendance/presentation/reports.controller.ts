import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { type ReportInput, Reports } from "../application/Reports";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import { PrismaReportsRepository } from "../infrastructure/prisma-reports";
import { ATTENDANCE_HTTP } from "./attendance-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const query = z.object({
  ano: z.uuid().optional(),
  periodo: z.enum(["ano", "1", "2", "3", "datas"]).optional(),
  de: day.optional(),
  ate: day.optional(),
  classe: z.uuid().optional(),
  turma: z.uuid().optional(),
  disciplina: z.uuid().optional(),
  professor: z.uuid().optional(),
});
const pipe = new ZodValidationPipe(query);
const input = (q: z.infer<typeof query>): ReportInput => ({ yearId: q.ano, period: q.periodo, from: q.de, to: q.ate, classId: q.classe, groupId: q.turma, subjectId: q.disciplina, teacherId: q.professor });

/**
 * Painéis e relatórios da assiduidade (só leitura). Pedagogia: attendance.reports.view ·
 * RH: attendance.teachers.view · o professor e o coordenador veem só o que é deles.
 */
@ApiTags("Portal · Relatórios de assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance/reports")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class ReportsController {
  constructor(
    private readonly reports: Reports,
    private readonly settings: AttendanceSettings,
  ) {}

  private rules(t: TenantContext) {
    return this.settings.rules(new PrismaAttendanceSettingsRepository(t.db));
  }

  @Get("pedagogy")
  @RequirePermission("attendance.reports.view")
  @ApiOperation({ summary: "Pedagogia: presença dos alunos, turmas, disciplinas, alunos com mais faltas, aulas sem registo e provas (filtros: ano, periodo, de, ate, classe, turma, disciplina, professor)" })
  async pedagogy(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(pipe) q: z.infer<typeof query>) {
    const [rules, perms] = await Promise.all([this.rules(t), permissionsOf(t.db, u)]);
    return unwrap(await this.reports.pedagogy(new PrismaReportsRepository(t.db), rules, { canSeeExams: perms.includes("attendance.exams.view") }, input(q)), ATTENDANCE_HTTP);
  }

  @Get("hr")
  @HrMay()
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "RH: assiduidade dos professores, faltas, aulas pendentes, registos em atraso, justificações e ocorrências (filtros: ano, periodo, de, ate, professor)" })
  async hr(@CurrentTenant() t: TenantContext, @Query(pipe) q: z.infer<typeof query>) {
    return unwrap(await this.reports.hr(new PrismaReportsRepository(t.db), await this.rules(t), input(q)), ATTENDANCE_HTTP);
  }

  @Get("me")
  @TeacherMay()
  @ApiOperation({ summary: "Professor: as suas aulas, presenças e turmas (filtros: ano, periodo, de, ate, classe, turma, disciplina)" })
  async me(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(pipe) q: z.infer<typeof query>) {
    return unwrap(await this.reports.teacher(new PrismaReportsRepository(t.db), await this.rules(t), u.id, input(q)), ATTENDANCE_HTTP);
  }

  @Get("coordination/:groupId")
  @TeacherMay()
  @ApiOperation({ summary: "Coordenador: uma turma que coordena, com todas as disciplinas (filtros: ano, periodo, de, ate, disciplina, professor)" })
  async coordination(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Query(pipe) q: z.infer<typeof query>) {
    return unwrap(await this.reports.coordination(new PrismaReportsRepository(t.db), await this.rules(t), u.id, groupId, input(q)), ATTENDANCE_HTTP);
  }
}
