import { Body, Controller, ForbiddenException, Get, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Patch, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { AttendanceSettings } from "../../attendance/application/AttendanceSettings";
import { StudentAlerts } from "../../attendance/application/StudentAlerts";
import { localNow } from "../../attendance/domain/presence";
import { PrismaAttendanceSettingsRepository } from "../../attendance/infrastructure/prisma-attendance-settings";
import { PrismaStudentAttendanceRepository } from "../../attendance/infrastructure/prisma-student-attendance";
import { Exams } from "../../exams/application/Exams";
import { PrismaExamsRepository } from "../../exams/infrastructure/prisma-exams";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { familyGrades } from "../../grading/application/FamilyGrades";
import { PrismaGradebookRepository } from "../../grading/infrastructure/prisma-gradebook";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { PEDAGOGY_HTTP } from "../../pedagogy/presentation/pedagogy.controller";
import { Teaching } from "../../pedagogy/application/Teaching";
import { Timetable } from "../../pedagogy/application/Timetable";
import { PrismaTeachingRepository } from "../../pedagogy/infrastructure/prisma-teaching";
import { PrismaTimetableRepository } from "../../pedagogy/infrastructure/prisma-timetable";
import { Students } from "../application/Students";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaStudentsRepository } from "../infrastructure/prisma-students";
import { Renewals } from "../application/Renewals";
import { PrismaRenewalsRepository } from "../infrastructure/prisma-renewals";

const STUDENTS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  NO_GROUPS: HttpStatus.NOT_FOUND,
  STUDENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  TEACHER_NOT_FOUND: HttpStatus.NOT_FOUND,
  FILE_NOT_FOUND: HttpStatus.NOT_FOUND,
};

const id = new ParseUUIDPipe({ version: "4" });
const listQuery = z.object({ q: z.string().max(80).optional(), year: z.uuid().optional(), class: z.uuid().optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).max(10_000).optional() });
const updateBody = z.record(z.string().max(40), z.unknown()).meta({ title: "StudentUpdate", description: "Os dados pessoais do aluno (as mesmas chaves do formulário de inscrição)." });
const repo = (t: TenantContext) => new PrismaStudentsRepository(t.db);

function sendFile(res: Response, f: { content: Buffer; mimeType: string; fileName: string }) {
  res.setHeader("Content-Type", f.mimeType);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return new StreamableFile(f.content);
}

/**
 * Secretaria · alunos. Ver: admissions.students.view · editar os dados pessoais: admissions.students.edit.
 * Nunca para professores (nem para o suporte: dados pessoais).
 */
@ApiTags("Portal · Secretaria · Alunos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions/students")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class StaffStudentsController {
  constructor(
    private readonly students: Students,
    private readonly stores: HrFileStores,
  ) {}

  @Get()
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Alunos: pesquisa (nome, n.º de aluno, n.º de matrícula, BI), filtros (ano, classe, estado), páginas" })
  list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.students.list(repo(t), { q: q.q, yearId: q.year, classId: q.class, status: q.status, page: q.page });
  }

  @Get("groups/:groupId")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Os alunos de uma turma (matrículas ativas), com a turma e o encarregado de cada aluno" })
  async group(@CurrentTenant() t: TenantContext, @Param("groupId", id) groupId: string) {
    return unwrap(await this.students.staffGroup(repo(t), groupId), STUDENTS_HTTP);
  }

  @Get(":id")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "A ficha do aluno: dados pessoais, encarregados, matrículas, inscrições, documentos e histórico" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string) {
    const canEdit = (await permissionsOf(t.db, u)).includes("admissions.students.edit");
    return unwrap(await this.students.get(repo(t), studentId, canEdit), STUDENTS_HTTP);
  }

  @Patch(":id")
  @RequirePermission("admissions.students.edit")
  @ApiOperation({ summary: "Alterar os dados pessoais (fica no histórico o que mudou)" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return unwrap(await this.students.update(repo(t), { id: u.support ? null : u.id }, studentId, body), STUDENTS_HTTP);
  }

  @Get(":id/files/:fileId")
  @RequirePermission("admissions.students.view")
  @ApiOperation({ summary: "Um ficheiro do aluno (fotografia ou documento entregue nas inscrições; decifrado pela API)" })
  async file(@CurrentTenant() t: TenantContext, @Param("id", id) studentId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.students.file(repo(t), this.stores.for(t.entry), studentId, fileId), STUDENTS_HTTP));
  }
}

/** O pedagógico não sabe quem é a família: este "ator" só lê (não gere horários). */
const FAMILY_READER = { id: "family", role: "FAMILIA", isOwner: false };

/** O horário da turma para a família: dias, tempos, disciplinas, professores e salas (sem dados de gestão). */
async function familyTimetable(timetable: Timetable, t: TenantContext, groupId: string) {
  const r = await timetable.groupTimetable(new PrismaTimetableRepository(t.db), FAMILY_READER, groupId);
  if (!r.ok) return null;
  const v = r.value;
  return {
    year: { name: v.year.name },
    cls: { label: v.cls.label, course: v.cls.course, courseCode: v.cls.courseCode },
    group: { name: v.group.name, shiftLabel: v.group.shiftLabel, room: v.group.room },
    coordinator: v.coordinator ? { id: v.coordinator.id, fullName: v.coordinator.fullName } : null,
    weekdays: v.weekdays,
    periods: v.periods.map((p) => ({ id: p.id, kind: p.kind, startsAt: p.startsAt, endsAt: p.endsAt })),
    lessons: v.lessons.filter((l) => l.subject).map((l) => ({ weekday: l.weekday, periodId: l.periodId, subject: l.subject!, teacherLabel: l.teacher ? l.teacherLabel : null, room: l.room })),
    // cada disciplina com a descrição e o professor (abre o contacto do professor)
    curriculum: v.curriculum.map((c) => ({
      subject: { id: c.subject.id, name: c.subject.name, code: c.subject.code, color: c.subject.color, description: c.subject.description },
      weeklyPeriods: c.weeklyPeriods,
      teacherLabel: c.teacher ? c.teacherLabel : null,
      teacher: c.teacher ? { id: c.teacher.id, fullName: c.teacher.fullName } : null,
    })),
  };
}
type FamilyTimetable = NonNullable<Awaited<ReturnType<typeof familyTimetable>>>;

/** As aulas de um dia, pela ordem dos tempos. */
const lessonsOn = (tt: FamilyTimetable, weekday: number) =>
  tt.periods
    .filter((p) => p.kind === "AULA")
    .flatMap((p) => {
      const l = tt.lessons.find((x) => x.weekday === weekday && x.periodId === p.id);
      return l ? [{ startsAt: p.startsAt, endsAt: p.endsAt, subject: l.subject, teacherLabel: l.teacherLabel, room: l.room }] : [];
    });

/** Área da família · os alunos da conta (o próprio aluno maior, ou os educandos menores que gere). */
@ApiTags("Área da família · Alunos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family/students")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyStudentsController {
  constructor(
    private readonly students: Students,
    private readonly stores: HrFileStores,
    private readonly timetable: Timetable,
    private readonly renewals: Renewals,
    private readonly alerts: StudentAlerts,
    private readonly attendanceSettings: AttendanceSettings,
    private readonly exams: Exams,
  ) {}

  @Get(":id/exams")
  @ApiOperation({ summary: "As provas publicadas da turma do aluno (a do ano em curso), com as canceladas e as anteriores" })
  async studentExams(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    // familyGroup confirma o acesso ao aluno (e que tem turma)
    const { groupId: latest } = unwrap(await this.students.familyGroup(repo(t), f.account.id, studentId), STUDENTS_HTTP);
    const { timeZone } = await this.attendanceSettings.rules(new PrismaAttendanceSettingsRepository(t.db));
    const groupId = (await new PrismaStudentAttendanceRepository(t.db).attendanceGroup(studentId, localNow(timeZone, new Date()).slice(0, 10))) ?? latest;
    return this.exams.group(PrismaExamsRepository.for(t.db), timeZone, groupId);
  }

  @Get(":id/attendance")
  @ApiOperation({ summary: "A assiduidade do aluno na turma atual: totais, por disciplina, faltas e atrasos (os mais recentes) e os alertas" })
  async attendance(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    // familyGroup confirma o acesso ao aluno (e que tem turma)
    const { groupId: latest } = unwrap(await this.students.familyGroup(repo(t), f.account.id, studentId), STUDENTS_HTTP);
    const rules = await this.attendanceSettings.rules(new PrismaAttendanceSettingsRepository(t.db));
    const att = new PrismaStudentAttendanceRepository(t.db);
    const groupId = (await att.attendanceGroup(studentId, localNow(rules.timeZone, new Date()).slice(0, 10))) ?? latest;
    return unwrap(await this.alerts.familyView(att, rules, studentId, groupId), STUDENTS_HTTP);
  }

  @Get(":id/grades")
  @ApiOperation({ summary: "As classificações publicadas do aluno no ano da turma atual: por disciplina e período (só o que a direção publicou; a retificação substitui a anterior)" })
  async grades(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    // familyGroup confirma o acesso ao aluno (e que tem turma)
    const { groupId: latest } = unwrap(await this.students.familyGroup(repo(t), f.account.id, studentId), STUDENTS_HTTP);
    const { timeZone } = await this.attendanceSettings.rules(new PrismaAttendanceSettingsRepository(t.db));
    const groupId = (await new PrismaStudentAttendanceRepository(t.db).attendanceGroup(studentId, localNow(timeZone, new Date()).slice(0, 10))) ?? latest;
    const r = await familyGrades(PrismaGradebookRepository.for(t.db), studentId, groupId);
    if (!r) throw new NotFoundException({ code: "NO_GROUPS", message: "Turma não encontrada." });
    return r;
  }

  @Get("journey")
  @ApiOperation({ summary: "O percurso: os alunos matriculados da conta, a matrícula atual e as aulas do dia (ou de segunda, ao fim de semana)" })
  async journey(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    const r = repo(t);
    const day = this.students.schoolDay();
    const [list, renewal] = await Promise.all([this.students.journey(r, f.account.id), this.renewals.familyStates(new PrismaRenewalsRepository(t.db), f.account.id)]);
    const cache = new Map<string, Promise<FamilyTimetable | null>>();
    const students = await Promise.all(
      list.map(async ({ groupId, ...s }) => {
        // a etapa "Renovação" do percurso: aberta, por abrir, em curso ou renovada
        const ren = renewal.get(s.id) ?? null;
        if (!groupId) return { ...s, renewal: ren, hasTimetable: false, day: null };
        if (!cache.has(groupId)) cache.set(groupId, familyTimetable(this.timetable, t, groupId));
        const tt = await cache.get(groupId)!;
        const weekday = tt?.weekdays.find((w) => w.value === day.weekday);
        return { ...s, renewal: ren, hasTimetable: !!tt && tt.lessons.length > 0, day: tt && weekday ? { today: day.today, label: day.today ? "Hoje" : weekday.label, lessons: lessonsOn(tt, day.weekday) } : null };
      }),
    );
    return { students };
  }

  @Get(":id/timetable")
  @ApiOperation({ summary: "O horário da turma do aluno (só leitura)" })
  async studentTimetable(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    const { groupId } = unwrap(await this.students.familyGroup(repo(t), f.account.id, studentId), STUDENTS_HTTP);
    const tt = await familyTimetable(this.timetable, t, groupId);
    if (!tt) throw new NotFoundException({ code: "NO_GROUPS", message: "Turma não encontrada." });
    return { ...tt, today: this.students.schoolDay() };
  }

  @Get(":id/teachers")
  @ApiOperation({ summary: "Os professores da turma do aluno: disciplinas, email e telefone (e se é o diretor de turma)" })
  async teachers(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    return unwrap(await this.students.familyTeachers(repo(t), f.account.id, studentId), STUDENTS_HTTP);
  }

  @Get(":id/teachers/:employeeId")
  @ApiOperation({ summary: "Um professor da turma do aluno: nome, função, email, telefone, disciplinas na turma e se é o diretor de turma" })
  async teacher(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string, @Param("employeeId", id) employeeId: string) {
    return unwrap(await this.students.familyTeacher(repo(t), f.account.id, studentId, employeeId), STUDENTS_HTTP);
  }

  @Get(":id/teachers/:employeeId/photo")
  @ApiOperation({ summary: "A fotografia de um professor da turma do aluno" })
  async teacherPhoto(
    @CurrentTenant() t: TenantContext,
    @CurrentFamily() f: FamilyPrincipal,
    @Param("id", id) studentId: string,
    @Param("employeeId", id) employeeId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendFile(res, unwrap(await this.students.familyTeacherPhoto(repo(t), this.stores.for(t.entry), f.account.id, studentId, employeeId), STUDENTS_HTTP));
  }

  @Get(":id")
  @ApiOperation({ summary: "O painel do aluno: dados, encarregados, matrículas, inscrições e documentos (só leitura)" })
  async get(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string) {
    return unwrap(await this.students.familyGet(repo(t), f.account.id, studentId), STUDENTS_HTTP);
  }

  @Get(":id/files/:fileId")
  @ApiOperation({ summary: "Um ficheiro do aluno (decifrado pela API)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) studentId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.students.familyFile(repo(t), this.stores.for(t.entry), f.account.id, studentId, fileId), STUDENTS_HTTP));
  }
}

/**
 * Professor · os alunos das minhas turmas (só onde dá aulas ou que coordena; as outras: 404).
 * O contacto do encarregado só para o coordenador (diretor de turma).
 */
@ApiTags("Portal · Professores")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy/my-classes")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class TeacherStudentsController {
  constructor(
    private readonly students: Students,
    private readonly teaching: Teaching,
    private readonly stores: HrFileStores,
  ) {}

  private async access(t: TenantContext, u: SchoolAccess, groupId: string) {
    return unwrap(await this.teaching.myGroupAccess(new PrismaTeachingRepository(t.db), u.id, groupId), PEDAGOGY_HTTP);
  }

  @Get(":id/students")
  @TeacherMay()
  @ApiOperation({ summary: "Os alunos de uma das minhas turmas (matrículas ativas)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    const a = await this.access(t, u, groupId);
    return this.students.groupStudents(repo(t), groupId, a.coordinates);
  }

  @Get(":id/students/:studentId")
  @TeacherMay()
  @ApiOperation({ summary: "Diretor de turma: o resumo de um aluno da turma (encarregados com os contactos; os do aluno se for maior)" })
  async summary(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string, @Param("studentId", id) studentId: string) {
    const a = await this.access(t, u, groupId);
    if (!a.coordinates) throw new ForbiddenException({ code: "FORBIDDEN", message: "Só o diretor de turma vê o resumo e os contactos do aluno." });
    return unwrap(await this.students.coordinatorStudent(repo(t), groupId, studentId), STUDENTS_HTTP);
  }

  @Get(":id/teachers")
  @TeacherMay()
  @ApiOperation({ summary: "Diretor de turma: os professores da turma (disciplinas, email, telefone)" })
  async teachers(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    const a = await this.access(t, u, groupId);
    if (!a.coordinates) throw new ForbiddenException({ code: "FORBIDDEN", message: "Só o diretor de turma vê os contactos dos professores da turma." });
    return this.students.coordinatorTeachers(repo(t), groupId);
  }

  @Get(":id/teachers/:employeeId/photo")
  @TeacherMay()
  @ApiOperation({ summary: "Diretor de turma: a fotografia de um professor da turma" })
  async teacherPhoto(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("id", id) groupId: string,
    @Param("employeeId", id) employeeId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const a = await this.access(t, u, groupId);
    if (!a.coordinates) throw new ForbiddenException({ code: "FORBIDDEN", message: "Só o diretor de turma vê os professores da turma." });
    return sendFile(res, unwrap(await this.students.coordinatorTeacherPhoto(repo(t), this.stores.for(t.entry), groupId, employeeId), STUDENTS_HTTP));
  }

  @Get(":id/students/:studentId/photo")
  @TeacherMay()
  @ApiOperation({ summary: "A fotografia de um aluno da turma" })
  async photo(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("id", id) groupId: string,
    @Param("studentId", id) studentId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.access(t, u, groupId);
    return sendFile(res, unwrap(await this.students.groupPhoto(repo(t), this.stores.for(t.entry), groupId, studentId), STUDENTS_HTTP));
  }
}
