import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { formatStudentNumber } from "../../admissions/domain/enrollment";
import { gradeLabel } from "../../pedagogy/domain/academic";
import type { Audience, Department, ExtraField, Method, RequestStatus } from "../domain/documents";

type Db = PrismaClient | Prisma.TransactionClient;
const json = (v: unknown) => JSON.stringify(v ?? null);

export interface TypeRow {
  id: string;
  audience: Audience;
  department: Department;
  category: string;
  name: string;
  description: string | null;
  requirements: string | null;
  method: Method;
  pickup: boolean;
  download: boolean;
  fee: number | null;
  slaDays: number;
  requiresApproval: boolean;
  fields: ExtraField[];
  active: boolean;
  position: number;
  requests: number;
  openRequests: number;
  updatedAt: Date;
}
export type TypeInput = Omit<TypeRow, "id" | "requests" | "openRequests" | "updatedAt" | "position">;

/** O beneficiário no momento do pedido (o pedido guarda esta cópia). */
export interface StudentSnapshot {
  kind: "STUDENT";
  name: string;
  number: string | null;
  birthDate: string;
  classId: string | null;
  classLabel: string | null;
  groupId: string | null;
  groupName: string | null;
  yearName: string | null;
  shift: string | null;
}
export interface EmployeeSnapshot {
  kind: "EMPLOYEE";
  name: string;
  number: string | null;
  jobTitle: string | null;
  department: string | null;
}
export type Beneficiary = StudentSnapshot | EmployeeSnapshot;

export interface RequestRow {
  id: string;
  number: number;
  year: number;
  typeId: string;
  typeName: string;
  category: string;
  audience: Audience;
  department: Department;
  method: Method;
  pickup: boolean;
  download: boolean;
  requiresApproval: boolean;
  fee: number | null;
  studentId: string | null;
  employeeId: string | null;
  beneficiary: Beneficiary;
  requesterKind: "FAMILY" | "EMPLOYEE" | "STAFF";
  requesterAccountId: string | null;
  requesterUserId: string | null;
  requesterName: string;
  relationship: "SELF" | "GUARDIAN" | "STAFF";
  answers: Record<string, string>;
  notes: string | null;
  status: RequestStatus;
  revision: number;
  dueOn: string | null;
  rejectReason: string | null;
  cancelReason: string | null;
  handledByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}
export interface EventRow {
  id: string;
  kind: "STATUS" | "NOTE";
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  note: string | null;
  internal: boolean;
  actorKind: string;
  actorName: string | null;
  at: Date;
}
export interface DeliveryRow {
  receivedBy: string;
  receivedByDocument: string | null;
  relationship: string;
  deliveredByName: string | null;
  deliveredAt: Date;
  notes: string | null;
}
export interface Actor {
  kind: "FAMILY" | "EMPLOYEE" | "STAFF" | "SYSTEM";
  id: string | null;
  name: string;
}
export interface ListFilter {
  audiences: Audience[];
  status?: RequestStatus | "OPEN" | null;
  q?: string | null;
  typeId?: string | null;
  department?: Department | null;
  classId?: string | null;
  groupId?: string | null;
  from?: string | null;
  to?: string | null;
  studentIds?: string[] | null;
  employeeId?: string | null;
  page: number;
  pageSize: number;
}

const TYPE_SQL = Prisma.sql`
  SELECT t.id, t.audience, t.department, t.category, t.name, t.description, t.requirements, t.method, t.pickup, t.download, t.fee,
         t.sla_days AS "slaDays", t.requires_approval AS "requiresApproval", t.fields, t.active, t.position, t.updated_at AS "updatedAt",
         (SELECT count(*)::int FROM document_requests r WHERE r.type_id = t.id) AS requests,
         (SELECT count(*)::int FROM document_requests r WHERE r.type_id = t.id AND r.status IN ('PENDING','IN_REVIEW','AWAITING_PAYMENT','PROCESSING','READY_PICKUP','READY_DOWNLOAD')) AS "openRequests"
    FROM document_types t`;
const REQUEST_SQL = Prisma.sql`
  SELECT r.id, r.number, r.year, r.type_id AS "typeId", r.type_name AS "typeName", r.category, r.audience, r.department, r.method, r.pickup, r.download,
         r.requires_approval AS "requiresApproval", r.fee, r.student_id AS "studentId", r.employee_id AS "employeeId", r.beneficiary,
         r.requester_kind AS "requesterKind", r.requester_account_id AS "requesterAccountId", r.requester_user_id AS "requesterUserId", r.requester_name AS "requesterName",
         r.relationship, r.answers, r.notes, r.status, r.revision, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", r.reject_reason AS "rejectReason", r.cancel_reason AS "cancelReason",
         r.handled_by_name AS "handledByName", r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.completed_at AS "completedAt"
    FROM document_requests r`;

/** Documentos: tipos, pedidos, histórico e entregas (BD do colégio). */
export class PrismaDocumentsRepository {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaDocumentsRepository(db);
  }
  async transaction<T>(fn: (repo: PrismaDocumentsRepository) => Promise<T>): Promise<T> {
    return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaDocumentsRepository(tx)), { timeout: 30_000 });
  }

  // ================================================================ tipos

  types(audiences: Audience[], activeOnly = false) {
    if (!audiences.length) return Promise.resolve([] as TypeRow[]);
    return this.db.$queryRaw<TypeRow[]>`${TYPE_SQL} WHERE t.audience IN (${Prisma.join(audiences)}) ${activeOnly ? Prisma.sql`AND t.active` : Prisma.empty} ORDER BY t.audience, t.position, lower(t.name)`;
  }
  async type(id: string): Promise<TypeRow | null> {
    const [r] = await this.db.$queryRaw<TypeRow[]>`${TYPE_SQL} WHERE t.id = ${id}::uuid`;
    return r ?? null;
  }
  async nameTaken(audience: Audience, name: string, except: string | null) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM document_types WHERE audience = ${audience} AND lower(name) = lower(${name}) ${except ? Prisma.sql`AND id <> ${except}::uuid` : Prisma.empty}`;
    return (r?.n ?? 0) > 0;
  }
  async createType(t: TypeInput, actorId: string | null, now: Date) {
    const id = randomUUID();
    await this.db.$executeRaw`
      INSERT INTO document_types (id, audience, department, category, name, description, requirements, method, pickup, download, fee, sla_days, requires_approval, fields, active, position, created_by_id, created_at, updated_at)
      VALUES (${id}::uuid, ${t.audience}, ${t.department}, ${t.category}, ${t.name}, ${t.description}, ${t.requirements}, ${t.method}, ${t.pickup}, ${t.download}, ${t.fee}, ${t.slaDays}, ${t.requiresApproval}, ${json(t.fields)}::jsonb, ${t.active},
              (SELECT coalesce(max(position), 0) + 1 FROM document_types WHERE audience = ${t.audience}), ${actorId}::uuid, ${now}, ${now})`;
    return id;
  }
  async updateType(id: string, t: TypeInput, now: Date) {
    await this.db.$executeRaw`
      UPDATE document_types SET department = ${t.department}, category = ${t.category}, name = ${t.name}, description = ${t.description}, requirements = ${t.requirements}, method = ${t.method},
             pickup = ${t.pickup}, download = ${t.download}, fee = ${t.fee}, sla_days = ${t.slaDays}, requires_approval = ${t.requiresApproval}, fields = ${json(t.fields)}::jsonb, active = ${t.active}, updated_at = ${now}
       WHERE id = ${id}::uuid`;
  }
  async setActive(id: string, active: boolean, now: Date) {
    await this.db.$executeRaw`UPDATE document_types SET active = ${active}, updated_at = ${now} WHERE id = ${id}::uuid`;
  }
  async deleteType(id: string) {
    await this.db.$executeRaw`DELETE FROM document_types WHERE id = ${id}::uuid AND NOT EXISTS (SELECT 1 FROM document_requests WHERE type_id = ${id}::uuid)`;
  }

  // ================================================================ beneficiários

  /** O aluno e a relação da conta da família com ele (o próprio, ou encarregado que o gere). */
  async familyLink(accountId: string, studentId: string) {
    const [r] = await this.db.$queryRaw<{ birthDate: string; self: boolean; managing: boolean }[]>`
      SELECT to_char(s.birth_date, 'YYYY-MM-DD') AS "birthDate", (s.account_id = ${accountId}::uuid) AS self,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing
        FROM students s WHERE s.id = ${studentId}::uuid`;
    return r ?? null;
  }
  /** Os alunos que a conta pode ver (o próprio e os que gere), para o catálogo. */
  familyStudents(accountId: string) {
    return this.db.$queryRaw<{ id: string; birthDate: string; self: boolean; managing: boolean }[]>`
      SELECT s.id, to_char(s.birth_date, 'YYYY-MM-DD') AS "birthDate", (s.account_id = ${accountId}::uuid) AS self,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing
        FROM students s
       WHERE s.account_id = ${accountId}::uuid
          OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage)
       ORDER BY lower(s.full_name)`;
  }
  /** Os dados do aluno que vão para o pedido: a matrícula mais recente (classe, turma, ano). */
  async studentSnapshot(studentId: string): Promise<StudentSnapshot | null> {
    const [r] = await this.db.$queryRaw<{ name: string; number: number | null; birthDate: string; classId: string | null; grade: number | null; courseName: string | null; groupId: string | null; groupName: string | null; yearName: string | null; shift: string | null }[]>`
      SELECT s.full_name AS name, s.number, to_char(s.birth_date, 'YYYY-MM-DD') AS "birthDate", e.class_id AS "classId", c.grade, co.name AS "courseName", e.group_id AS "groupId", g.name AS "groupName", y.name AS "yearName", e.shift
        FROM students s
        LEFT JOIN LATERAL (SELECT * FROM enrollments e WHERE e.student_id = s.id AND e.status = 'ACTIVE' ORDER BY e.enrolled_at DESC LIMIT 1) e ON true
        LEFT JOIN school_classes c ON c.id = e.class_id LEFT JOIN courses co ON co.id = c.course_id
        LEFT JOIN class_groups g ON g.id = e.group_id LEFT JOIN academic_years y ON y.id = e.academic_year_id
       WHERE s.id = ${studentId}::uuid`;
    if (!r) return null;
    return {
      kind: "STUDENT",
      name: r.name,
      number: formatStudentNumber(r.number),
      birthDate: r.birthDate,
      classId: r.classId,
      classLabel: r.grade === null ? null : `${gradeLabel(r.grade)}${r.courseName ? ` — ${r.courseName}` : ""}`,
      groupId: r.groupId,
      groupName: r.groupName,
      yearName: r.yearName,
      shift: r.shift,
    };
  }
  async familyName(accountId: string) {
    const [r] = await this.db.$queryRaw<{ name: string }[]>`SELECT full_name AS name FROM family_accounts WHERE id = ${accountId}::uuid`;
    return r?.name ?? "Família";
  }
  /** O funcionário ligado a uma conta do portal (só com o vínculo ativo). */
  async employeeOfUser(userId: string) {
    const [r] = await this.db.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM employees WHERE user_id = ${userId}::uuid`;
    return r ?? null;
  }
  async employeeSnapshot(employeeId: string): Promise<(EmployeeSnapshot & { status: string; userId: string | null }) | null> {
    const [r] = await this.db.$queryRaw<{ name: string; number: number | null; jobTitle: string | null; department: string | null; status: string; userId: string | null }[]>`
      SELECT full_name AS name, number, job_title AS "jobTitle", department, status, user_id AS "userId" FROM employees WHERE id = ${employeeId}::uuid`;
    if (!r) return null;
    return { kind: "EMPLOYEE", name: r.name, number: r.number ? String(r.number).padStart(4, "0") : null, jobTitle: r.jobTitle, department: r.department, status: r.status, userId: r.userId };
  }
  async userName(userId: string) {
    const [r] = await this.db.$queryRaw<{ name: string }[]>`SELECT full_name AS name FROM school_users WHERE id = ${userId}::uuid`;
    return r?.name ?? "Equipa do colégio";
  }

  // ================================================================ pedidos

  async createRequest(r: Omit<RequestRow, "id" | "number" | "revision" | "status" | "rejectReason" | "cancelReason" | "handledByName" | "createdAt" | "updatedAt" | "completedAt">, actor: Actor, now: Date) {
    const id = randomUUID();
    const [row] = await this.db.$queryRaw<{ number: number }[]>`
      INSERT INTO document_requests (id, year, type_id, type_name, category, audience, department, method, pickup, download, requires_approval, fee, student_id, employee_id, beneficiary,
                                     requester_kind, requester_account_id, requester_user_id, requester_name, relationship, answers, notes, status, due_on, created_at, updated_at)
      VALUES (${id}::uuid, ${r.year}, ${r.typeId}::uuid, ${r.typeName}, ${r.category}, ${r.audience}, ${r.department}, ${r.method}, ${r.pickup}, ${r.download}, ${r.requiresApproval}, ${r.fee},
              ${r.studentId}::uuid, ${r.employeeId}::uuid, ${json(r.beneficiary)}::jsonb, ${r.requesterKind}, ${r.requesterAccountId}::uuid, ${r.requesterUserId}::uuid, ${r.requesterName}, ${r.relationship},
              ${json(r.answers)}::jsonb, ${r.notes}, 'PENDING', ${r.dueOn}::date, ${now}, ${now})
      RETURNING number`;
    await this.event(id, { kind: "STATUS", from: null, to: "PENDING", note: null, internal: false }, actor, now);
    return { id, number: row.number };
  }
  async request(id: string): Promise<RequestRow | null> {
    const [r] = await this.db.$queryRaw<RequestRow[]>`${REQUEST_SQL} WHERE r.id = ${id}::uuid`;
    return r ?? null;
  }
  private where(f: ListFilter) {
    const parts: Prisma.Sql[] = [Prisma.sql`r.audience IN (${Prisma.join(f.audiences)})`];
    if (f.status === "OPEN") parts.push(Prisma.sql`r.status IN ('PENDING','IN_REVIEW','AWAITING_PAYMENT','PROCESSING','READY_PICKUP','READY_DOWNLOAD')`);
    else if (f.status) parts.push(Prisma.sql`r.status = ${f.status}`);
    if (f.typeId) parts.push(Prisma.sql`r.type_id = ${f.typeId}::uuid`);
    if (f.department) parts.push(Prisma.sql`r.department = ${f.department}`);
    if (f.classId) parts.push(Prisma.sql`r.beneficiary->>'classId' = ${f.classId}`);
    if (f.groupId) parts.push(Prisma.sql`r.beneficiary->>'groupId' = ${f.groupId}`);
    if (f.from) parts.push(Prisma.sql`r.created_at >= ${f.from}::date`);
    if (f.to) parts.push(Prisma.sql`r.created_at < (${f.to}::date + 1)`);
    if (f.studentIds) parts.push(f.studentIds.length ? Prisma.sql`r.student_id IN (${Prisma.join(f.studentIds.map((s) => Prisma.sql`${s}::uuid`))})` : Prisma.sql`false`);
    if (f.employeeId) parts.push(Prisma.sql`r.employee_id = ${f.employeeId}::uuid`);
    if (f.q) {
      const like = `%${f.q}%`;
      parts.push(
        Prisma.sql`(r.beneficiary->>'name' ILIKE ${like} OR r.beneficiary->>'number' ILIKE ${like} OR r.type_name ILIKE ${like} OR r.requester_name ILIKE ${like}
                    OR ('DOC-' || r.year || '-' || lpad(r.number::text, 6, '0')) ILIKE ${like} OR r.beneficiary->>'groupName' ILIKE ${like} OR r.beneficiary->>'classLabel' ILIKE ${like})`,
      );
    }
    return Prisma.join(parts, " AND ");
  }
  async list(f: ListFilter) {
    if (!f.audiences.length) return { total: 0, rows: [] as RequestRow[] };
    const w = this.where(f);
    const [rows, [c]] = await Promise.all([
      this.db.$queryRaw<RequestRow[]>`${REQUEST_SQL} WHERE ${w} ORDER BY r.created_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM document_requests r WHERE ${w}`,
    ]);
    return { total: c?.n ?? 0, rows };
  }
  /** Quantos pedidos em cada estado (com os mesmos filtros, sem o do estado). */
  statusCounts(f: ListFilter) {
    if (!f.audiences.length) return Promise.resolve([] as { status: RequestStatus; n: number }[]);
    return this.db.$queryRaw<{ status: RequestStatus; n: number }[]>`SELECT r.status, count(*)::int AS n FROM document_requests r WHERE ${this.where({ ...f, status: null })} GROUP BY r.status`;
  }
  events(requestId: string) {
    return this.db.$queryRaw<EventRow[]>`
      SELECT id, kind, from_status AS "fromStatus", to_status AS "toStatus", note, internal, actor_kind AS "actorKind", actor_name AS "actorName", at
        FROM document_request_events WHERE request_id = ${requestId}::uuid ORDER BY at, id`;
  }
  async event(requestId: string, e: { kind: "STATUS" | "NOTE"; from: RequestStatus | null; to: RequestStatus | null; note: string | null; internal: boolean }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO document_request_events (id, request_id, kind, from_status, to_status, note, internal, actor_kind, actor_id, actor_name, at)
      VALUES (${randomUUID()}::uuid, ${requestId}::uuid, ${e.kind}, ${e.from}, ${e.to}, ${e.note}, ${e.internal}, ${actor.kind}, ${actor.id}::uuid, ${actor.name}, ${now})`;
  }
  /** Muda o estado se ninguém o mudou entretanto (revisão e estado de partida). false = mudou. */
  async move(id: string, from: RequestStatus, to: RequestStatus, revision: number, set: { rejectReason?: string | null; cancelReason?: string | null; handled?: Actor | null; completed?: boolean }, now: Date) {
    const n = await this.db.$executeRaw`
      UPDATE document_requests SET status = ${to}, revision = revision + 1, updated_at = ${now},
             reject_reason = ${set.rejectReason === undefined ? Prisma.sql`reject_reason` : set.rejectReason},
             cancel_reason = ${set.cancelReason === undefined ? Prisma.sql`cancel_reason` : set.cancelReason},
             handled_by_id = ${set.handled ? Prisma.sql`${set.handled.id}::uuid` : Prisma.sql`handled_by_id`},
             handled_by_name = ${set.handled ? set.handled.name : Prisma.sql`handled_by_name`},
             completed_at = ${set.completed ? now : Prisma.sql`completed_at`}
       WHERE id = ${id}::uuid AND status = ${from} AND revision = ${revision}`;
    return n === 1;
  }
  async deliver(requestId: string, d: { receivedBy: string; receivedByDocument: string | null; relationship: string; notes: string | null }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO document_deliveries (id, request_id, received_by, received_by_document, relationship, delivered_by_id, delivered_by_name, delivered_at, notes)
      VALUES (${randomUUID()}::uuid, ${requestId}::uuid, ${d.receivedBy}, ${d.receivedByDocument}, ${d.relationship}, ${actor.id}::uuid, ${actor.name}, ${now}, ${d.notes})`;
  }
  async delivery(requestId: string): Promise<DeliveryRow | null> {
    const [r] = await this.db.$queryRaw<DeliveryRow[]>`
      SELECT received_by AS "receivedBy", received_by_document AS "receivedByDocument", relationship, delivered_by_name AS "deliveredByName", delivered_at AS "deliveredAt", notes
        FROM document_deliveries WHERE request_id = ${requestId}::uuid`;
    return r ?? null;
  }

  // ================================================================ a quem avisar

  /** Quem recebe os avisos da família sobre um aluno: o próprio (com conta) e, enquanto menor, quem o gere. */
  familyRecipients(studentId: string, today: string) {
    return this.db.$queryRaw<{ accountId: string }[]>`
      SELECT DISTINCT a.account_id AS "accountId" FROM (
        SELECT st.account_id FROM students st WHERE st.id = ${studentId}::uuid AND st.account_id IS NOT NULL
        UNION
        SELECT gu.account_id FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id JOIN students st ON st.id = sg.student_id
         WHERE sg.student_id = ${studentId}::uuid AND sg.can_manage AND gu.account_id IS NOT NULL AND ${today}::date < (st.birth_date + interval '18 years')::date
      ) a JOIN family_accounts fa ON fa.id = a.account_id AND fa.status = 'ACTIVE'`;
  }
  /** Quem tem uma das permissões (e o responsável do colégio). */
  usersWithAny(permissions: string[]) {
    return this.db.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM school_users u WHERE u.status = 'ACTIVE' AND (u.is_owner OR EXISTS (SELECT 1 FROM school_user_permissions p WHERE p.user_id = u.id AND p.permission IN (${Prisma.join(permissions)})))`;
  }
}
