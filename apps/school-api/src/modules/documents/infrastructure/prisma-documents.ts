import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { formatStudentNumber } from "../../admissions/domain/enrollment";
import { gradeLabel } from "../../pedagogy/domain/academic";
import type { AttachmentItem, Audience, Department, ExtraField, Method, RequestStatus } from "../domain/documents";
import { PrismaCardsRepository } from "./prisma-cards";

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
  feePolicy: FeePolicy;
  slaDays: number;
  requiresApproval: boolean;
  fields: ExtraField[];
  /** os documentos que quem pede junta */
  attachments: AttachmentItem[];
  active: boolean;
  position: number;
  /** a versão mais recente do modelo (null = sem modelo) */
  templateVersion: number | null;
  requests: number;
  openRequests: number;
  updatedAt: Date;
}
export type TypeInput = Omit<TypeRow, "id" | "requests" | "openRequests" | "updatedAt" | "position" | "templateVersion">;
export type FeePolicy = "BEFORE" | "ON_DELIVERY";

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
  feePolicy: FeePolicy | null;
  chargeId: string | null;
  /** OPEN | PAID | WAIVED | VOID (null = sem taxa) */
  chargeStatus: string | null;
  /** há um pagamento desta cobrança à espera das Finanças */
  chargeInValidation: boolean;
}
export interface TemplateRow {
  id: string;
  version: number;
  title: string;
  body: string;
  signerName: string | null;
  signerRole: string | null;
  showLogo: boolean;
  createdByName: string | null;
  createdAt: Date;
}
export interface IssuedRow {
  id: string;
  version: number;
  method: "AUTO" | "EXTERNAL";
  templateVersion: number | null;
  fileKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: "ACTIVE" | "REPLACED";
  reason: string | null;
  createdByName: string | null;
  createdAt: Date;
}
export interface AttachmentRow {
  id: string;
  itemKey: string;
  label: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageKey: string;
  uploadedByKind: "FAMILY" | "EMPLOYEE" | "STAFF";
  uploadedByName: string | null;
  createdAt: Date;
}
export interface EventRow {
  id: string;
  kind: "STATUS" | "NOTE" | "FILE" | "PAYMENT";
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
  SELECT t.id, t.audience, t.department, t.category, t.name, t.description, t.requirements, t.method, t.pickup, t.download, t.fee, t.fee_policy AS "feePolicy",
         t.sla_days AS "slaDays", t.requires_approval AS "requiresApproval", t.fields, t.attachments, t.active, t.position, t.updated_at AS "updatedAt",
         (SELECT max(v.version) FROM document_templates v WHERE v.type_id = t.id) AS "templateVersion",
         (SELECT count(*)::int FROM document_requests r WHERE r.type_id = t.id) AS requests,
         (SELECT count(*)::int FROM document_requests r WHERE r.type_id = t.id AND r.status IN ('PENDING','IN_REVIEW','AWAITING_PAYMENT','PROCESSING','READY_PICKUP','READY_DOWNLOAD')) AS "openRequests"
    FROM document_types t`;
const REQUEST_SQL = Prisma.sql`
  SELECT r.id, r.number, r.year, r.type_id AS "typeId", r.type_name AS "typeName", r.category, r.audience, r.department, r.method, r.pickup, r.download,
         r.requires_approval AS "requiresApproval", r.fee, r.student_id AS "studentId", r.employee_id AS "employeeId", r.beneficiary,
         r.requester_kind AS "requesterKind", r.requester_account_id AS "requesterAccountId", r.requester_user_id AS "requesterUserId", r.requester_name AS "requesterName",
         r.relationship, r.answers, r.notes, r.status, r.revision, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", r.reject_reason AS "rejectReason", r.cancel_reason AS "cancelReason",
         r.handled_by_name AS "handledByName", r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.completed_at AS "completedAt",
         r.fee_policy AS "feePolicy", r.charge_id AS "chargeId", c.status AS "chargeStatus",
         coalesce((SELECT bool_or(p.status = 'SUBMITTED') FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = r.charge_id), false) AS "chargeInValidation"
    FROM document_requests r LEFT JOIN charges c ON c.id = r.charge_id`;

/** Documentos: tipos, pedidos, histórico e entregas (BD do colégio). */
export class PrismaDocumentsRepository {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaDocumentsRepository(db);
  }
  async transaction<T>(fn: (repo: PrismaDocumentsRepository) => Promise<T>): Promise<T> {
    return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaDocumentsRepository(tx)), { timeout: 30_000 });
  }
  /** Os cartões de estudante, na mesma ligação (os pedidos de cartão emitem-nos). */
  cards() {
    return new PrismaCardsRepository(this.db);
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
      INSERT INTO document_types (id, audience, department, category, name, description, requirements, method, pickup, download, fee, fee_policy, sla_days, requires_approval, fields, attachments, active, position, created_by_id, created_at, updated_at)
      VALUES (${id}::uuid, ${t.audience}, ${t.department}, ${t.category}, ${t.name}, ${t.description}, ${t.requirements}, ${t.method}, ${t.pickup}, ${t.download}, ${t.fee}, ${t.feePolicy}, ${t.slaDays}, ${t.requiresApproval}, ${json(t.fields)}::jsonb, ${json(t.attachments)}::jsonb, ${t.active},
              (SELECT coalesce(max(position), 0) + 1 FROM document_types WHERE audience = ${t.audience}), ${actorId}::uuid, ${now}, ${now})`;
    return id;
  }
  async updateType(id: string, t: TypeInput, now: Date) {
    await this.db.$executeRaw`
      UPDATE document_types SET department = ${t.department}, category = ${t.category}, name = ${t.name}, description = ${t.description}, requirements = ${t.requirements}, method = ${t.method},
             pickup = ${t.pickup}, download = ${t.download}, fee = ${t.fee}, fee_policy = ${t.feePolicy}, sla_days = ${t.slaDays}, requires_approval = ${t.requiresApproval}, fields = ${json(t.fields)}::jsonb, attachments = ${json(t.attachments)}::jsonb, active = ${t.active}, updated_at = ${now}
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

  async createRequest(r: Omit<RequestRow, "id" | "number" | "revision" | "status" | "rejectReason" | "cancelReason" | "handledByName" | "createdAt" | "updatedAt" | "completedAt" | "chargeStatus" | "chargeInValidation">, actor: Actor, now: Date, id = randomUUID()) {
    const [row] = await this.db.$queryRaw<{ number: number }[]>`
      INSERT INTO document_requests (id, year, type_id, type_name, category, audience, department, method, pickup, download, requires_approval, fee, fee_policy, charge_id, student_id, employee_id, beneficiary,
                                     requester_kind, requester_account_id, requester_user_id, requester_name, relationship, answers, notes, status, due_on, created_at, updated_at)
      VALUES (${id}::uuid, ${r.year}, ${r.typeId}::uuid, ${r.typeName}, ${r.category}, ${r.audience}, ${r.department}, ${r.method}, ${r.pickup}, ${r.download}, ${r.requiresApproval}, ${r.fee}, ${r.feePolicy}, ${r.chargeId}::uuid,
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
  async event(requestId: string, e: { kind: "STATUS" | "NOTE" | "FILE" | "PAYMENT"; from: RequestStatus | null; to: RequestStatus | null; note: string | null; internal: boolean }, actor: Actor, now: Date) {
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

  // ================================================================ taxas (cobranças das Finanças)

  /** O ano letivo da cobrança: o da matrícula ativa do aluno, ou o ano em curso. */
  async chargeYear(studentId: string, today: string) {
    const [r] = await this.db.$queryRaw<{ yearId: string | null; enrollmentId: string | null }[]>`
      SELECT coalesce(e.academic_year_id, y.id) AS "yearId", e.id AS "enrollmentId"
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (SELECT id, academic_year_id FROM enrollments WHERE student_id = ${studentId}::uuid AND status = 'ACTIVE' ORDER BY enrolled_at DESC LIMIT 1) e ON true
        LEFT JOIN LATERAL (SELECT id FROM academic_years WHERE status = 'ACTIVE' OR (status <> 'CLOSED' AND ends_on >= ${today}::date) ORDER BY (status = 'ACTIVE') DESC, starts_on LIMIT 1) y ON true`;
    return r?.yearId ? { yearId: r.yearId, enrollmentId: r.enrollmentId } : null;
  }
  /** A cobrança da taxa (kind DOCUMENTO): aparece nos pagamentos da família e paga-se pelo fluxo das Finanças. */
  async createCharge(c: { id: string; label: string; amount: number; yearId: string; enrollmentId: string | null; studentId: string; dueOn: string }, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO charges (id, kind, label, amount, academic_year_id, student_id, enrollment_id, due_on, status, created_at, updated_at)
      VALUES (${c.id}::uuid, 'DOCUMENTO', ${c.label}, ${c.amount}, ${c.yearId}::uuid, ${c.studentId}::uuid, ${c.enrollmentId}::uuid, ${c.dueOn}::date, 'OPEN', ${now}, ${now})`;
  }
  renameCharge(chargeId: string, label: string, now: Date) {
    return this.db.$executeRaw`UPDATE charges SET label = ${label}, updated_at = ${now} WHERE id = ${chargeId}::uuid`;
  }
  /** Anula a cobrança ainda por pagar (pedido cancelado ou rejeitado). */
  voidCharge(chargeId: string, now: Date) {
    return this.db.$executeRaw`UPDATE charges SET status = 'VOID', updated_at = ${now} WHERE id = ${chargeId}::uuid AND status = 'OPEN'`;
  }
  /** Os pedidos à espera do pagamento cuja cobrança já está paga ou isenta. */
  paidWhileWaiting() {
    return this.db.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM document_requests r JOIN charges c ON c.id = r.charge_id WHERE r.status = 'AWAITING_PAYMENT' AND c.status IN ('PAID', 'WAIVED')`;
  }

  // ================================================================ modelos e documentos emitidos

  templates(typeId: string) {
    return this.db.$queryRaw<TemplateRow[]>`
      SELECT id, version, title, body, signer_name AS "signerName", signer_role AS "signerRole", show_logo AS "showLogo", created_by_name AS "createdByName", created_at AS "createdAt"
        FROM document_templates WHERE type_id = ${typeId}::uuid ORDER BY version DESC`;
  }
  async latestTemplate(typeId: string): Promise<TemplateRow | null> {
    return (await this.templates(typeId))[0] ?? null;
  }
  /** Nova versão do modelo (as anteriores ficam, para o histórico e as versões emitidas). */
  async addTemplate(typeId: string, t: { title: string; body: string; signerName: string | null; signerRole: string | null; showLogo: boolean }, actor: Actor, now: Date) {
    const [r] = await this.db.$queryRaw<{ version: number }[]>`
      INSERT INTO document_templates (id, type_id, version, title, body, signer_name, signer_role, show_logo, created_by_id, created_by_name, created_at)
      VALUES (${randomUUID()}::uuid, ${typeId}::uuid, (SELECT coalesce(max(version), 0) + 1 FROM document_templates WHERE type_id = ${typeId}::uuid),
              ${t.title}, ${t.body}, ${t.signerName}, ${t.signerRole}, ${t.showLogo}, ${actor.id}::uuid, ${actor.name}, ${now})
      RETURNING version`;
    return r.version;
  }
  issued(requestId: string) {
    return this.db.$queryRaw<IssuedRow[]>`
      SELECT id, version, method, template_version AS "templateVersion", file_key AS "fileKey", file_name AS "fileName", mime_type AS "mimeType", size, sha256, status, reason,
             created_by_name AS "createdByName", created_at AS "createdAt"
        FROM issued_documents WHERE request_id = ${requestId}::uuid ORDER BY version DESC`;
  }
  async activeIssued(requestId: string): Promise<IssuedRow | null> {
    return (await this.issued(requestId)).find((d) => d.status === "ACTIVE") ?? null;
  }
  /** Guarda a nova versão emitida (a ativa anterior fica substituída). */
  async addIssued(requestId: string, d: { method: "AUTO" | "EXTERNAL"; templateVersion: number | null; fileKey: string; fileName: string; mimeType: string; size: number; sha256: string; reason: string | null }, actor: Actor, now: Date) {
    await this.db.$executeRaw`UPDATE issued_documents SET status = 'REPLACED', replaced_at = ${now} WHERE request_id = ${requestId}::uuid AND status = 'ACTIVE'`;
    const [r] = await this.db.$queryRaw<{ version: number }[]>`
      INSERT INTO issued_documents (id, request_id, version, method, template_version, file_key, file_name, mime_type, size, sha256, status, reason, created_by_id, created_by_name, created_at)
      VALUES (${randomUUID()}::uuid, ${requestId}::uuid, (SELECT coalesce(max(version), 0) + 1 FROM issued_documents WHERE request_id = ${requestId}::uuid), ${d.method}, ${d.templateVersion},
              ${d.fileKey}, ${d.fileName}, ${d.mimeType}, ${d.size}, ${d.sha256}, 'ACTIVE', ${d.reason}, ${actor.id}::uuid, ${actor.name}, ${now})
      RETURNING version`;
    return r.version;
  }

  // ================================================================ documentos juntos por quem pede

  attachments(requestId: string) {
    return this.db.$queryRaw<AttachmentRow[]>`
      SELECT id, item_key AS "itemKey", label, file_name AS "fileName", mime_type AS "mimeType", size, sha256, storage_key AS "storageKey",
             uploaded_by_kind AS "uploadedByKind", uploaded_by_name AS "uploadedByName", created_at AS "createdAt"
        FROM document_request_files WHERE request_id = ${requestId}::uuid ORDER BY created_at DESC, id`;
  }
  async addAttachment(requestId: string, f: { itemKey: string; label: string; fileName: string; mimeType: string; size: number; sha256: string; storageKey: string }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO document_request_files (id, request_id, item_key, label, file_name, mime_type, size, sha256, storage_key, uploaded_by_kind, uploaded_by_name, created_at)
      VALUES (${randomUUID()}::uuid, ${requestId}::uuid, ${f.itemKey}, ${f.label}, ${f.fileName}, ${f.mimeType}, ${f.size}, ${f.sha256}, ${f.storageKey},
              ${actor.kind === "SYSTEM" ? "STAFF" : actor.kind}, ${actor.name}, ${now})`;
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
