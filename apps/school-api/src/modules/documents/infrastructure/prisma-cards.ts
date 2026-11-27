import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { formatStudentNumber } from "../../admissions/domain/enrollment";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { type CardModel, type CardSettings, type CardStatus, DEFAULT_CARD_SETTINGS } from "../domain/cards";
import type { Actor } from "./prisma-documents";

type Db = PrismaClient | Prisma.TransactionClient;
/** o "assunto" das alterações da configuração dos cartões no registo de atividade */
const SETTINGS_SUBJECT = "00000000-0000-0000-0000-0000000000ca";

/** A cópia do que foi impresso num cartão (reimprimir dá o mesmo cartão). */
export interface CardData {
  name: string;
  number: string | null;
  classLabel: string | null;
  groupName: string | null;
  yearName: string;
  school: { name: string; address: string | null; phone: string | null; email: string | null };
  primary: string;
  accent: string;
  showQr: boolean;
  backNote: string;
  photoKey: string;
  /** o logótipo com que foi emitido (cópia no armazenamento do colégio); null/ausente = sem logótipo */
  logoKey?: string | null;
  /** o cabeçalho oficial com que foi emitido (a insígnia pela chave); null = sem; ausente = cartão anterior (usa o atual) */
  header?: { lines?: string[]; /** formato anterior (0052) */ country?: string; ministry?: string | null; emblemKey: string | null } | null;
}
export interface CardRow {
  id: string;
  number: number;
  studentId: string;
  yearId: string;
  yearName: string;
  version: number;
  code: string;
  model: CardModel;
  data: CardData;
  validUntil: string;
  status: CardStatus;
  reason: string | null;
  revokeReason: string | null;
  requestId: string | null;
  createdByName: string | null;
  createdAt: Date;
  endedAt: Date | null;
  studentStatus: string;
}
/** O aluno como vai para o cartão: a matrícula ativa (ano, classe, turma). */
export interface CardTarget {
  id: string;
  name: string;
  number: string | null;
  status: string;
  yearId: string | null;
  yearName: string | null;
  endsOn: string | null;
  classLabel: string | null;
  groupName: string | null;
}
export interface PhotoRow {
  source: "UPLOAD" | "APPLICATION";
  storageKey: string;
  mimeType: string;
  fileName: string;
}

const classLabel = (grade: number | null, course: string | null) => (grade === null ? null : `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`);
/** a fotografia do aluno: a carregada pela secretaria (escolha explícita, prevalece) ou, sem ela, a da inscrição submetida */
const PHOTO_LATERAL = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT 'UPLOAD' AS source, sp.storage_key, sp.mime_type, sp.file_name, sp.created_at FROM student_photos sp WHERE sp.student_id = s.id
      UNION ALL
      SELECT 'APPLICATION', fi.storage_key, fi.mime_type, fi.file_name, fi.created_at FROM application_files fi JOIN applications a ON a.id = fi.application_id
       WHERE a.student_id = s.id AND fi.slot = 'PHOTO' AND a.status <> 'DRAFT'
    ) x ORDER BY (x.source = 'UPLOAD') DESC, x.created_at DESC LIMIT 1
  ) ph ON true`;
const CARD_SQL = Prisma.sql`
  SELECT sc.id, sc.number, sc.student_id AS "studentId", sc.academic_year_id AS "yearId", y.name AS "yearName", sc.version, sc.code, sc.model, sc.data,
         to_char(sc.valid_until, 'YYYY-MM-DD') AS "validUntil", sc.status, sc.reason, sc.revoke_reason AS "revokeReason", sc.request_id AS "requestId",
         sc.created_by_name AS "createdByName", sc.created_at AS "createdAt", sc.ended_at AS "endedAt", s.status AS "studentStatus"
    FROM student_cards sc JOIN students s ON s.id = sc.student_id JOIN academic_years y ON y.id = sc.academic_year_id`;

/** Cartões de estudante: a configuração, as fotografias, os cartões emitidos (BD do colégio). */
export class PrismaCardsRepository {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaCardsRepository(db);
  }
  async transaction<T>(fn: (repo: PrismaCardsRepository) => Promise<T>): Promise<T> {
    return (this.db as PrismaClient).$transaction((tx) => fn(new PrismaCardsRepository(tx)), { timeout: 30_000 });
  }

  // ================================================================ configuração

  async settings(): Promise<CardSettings & { updatedByName: string | null; updatedAt: Date | null }> {
    const [r] = await this.db.$queryRaw<(CardSettings & { updatedByName: string | null; updatedAt: Date | null })[]>`
      SELECT model, primary_color AS "primaryColor", accent_color AS "accentColor", address, phone, email, show_qr AS "showQr", back_note AS "backNote",
             updated_by_name AS "updatedByName", updated_at AS "updatedAt"
        FROM student_card_settings WHERE id = 1`;
    return r ?? { ...DEFAULT_CARD_SETTINGS, updatedByName: null, updatedAt: null };
  }
  /** O logótipo já copiado para o armazenamento do colégio (e o SHA-256 da cópia). */
  async logo() {
    const [r] = await this.db.$queryRaw<{ key: string | null; sha: string | null }[]>`SELECT logo_key AS key, logo_sha256 AS sha FROM student_card_settings WHERE id = 1`;
    return r ?? { key: null, sha: null };
  }
  async setLogo(key: string, sha: string) {
    await this.db.$executeRaw`
      INSERT INTO student_card_settings (id, logo_key, logo_sha256) VALUES (1, ${key}, ${sha})
      ON CONFLICT (id) DO UPDATE SET logo_key = EXCLUDED.logo_key, logo_sha256 = EXCLUDED.logo_sha256`;
  }
  async saveSettings(s: CardSettings, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO student_card_settings (id, model, primary_color, accent_color, address, phone, email, show_qr, back_note, updated_by_id, updated_by_name, updated_at)
      VALUES (1, ${s.model}, ${s.primaryColor}, ${s.accentColor}, ${s.address}, ${s.phone}, ${s.email}, ${s.showQr}, ${s.backNote}, ${actor.id}::uuid, ${actor.name}, ${now})
      ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, primary_color = EXCLUDED.primary_color, accent_color = EXCLUDED.accent_color, address = EXCLUDED.address,
             phone = EXCLUDED.phone, email = EXCLUDED.email, show_qr = EXCLUDED.show_qr, back_note = EXCLUDED.back_note,
             updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at`;
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type: "documents.cards.settings", subjectId: SETTINGS_SUBJECT, actorId: actor.id, details: { ...s } as Prisma.InputJsonValue, occurredAt: now } });
  }

  // ================================================================ ano, turmas e alunos

  /** O ano letivo dos cartões: o ativo ou, sem ele, o que está a decorrer. */
  async currentYear(today: string) {
    const [r] = await this.db.$queryRaw<{ id: string; name: string; endsOn: string }[]>`
      SELECT id, name, to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_years
       WHERE status = 'ACTIVE' OR (status <> 'CLOSED' AND ${today}::date BETWEEN starts_on AND ends_on)
       ORDER BY (status = 'ACTIVE') DESC, starts_on DESC LIMIT 1`;
    return r ?? null;
  }
  /** Os anos letivos por fechar (o seguinte também: os cartões imprimem-se depois das matrículas). */
  openYears() {
    return this.db.$queryRaw<{ id: string; name: string; endsOn: string; status: string }[]>`
      SELECT id, name, to_char(ends_on, 'YYYY-MM-DD') AS "endsOn", status FROM academic_years WHERE status <> 'CLOSED' ORDER BY starts_on`;
  }
  /** As turmas do ano, com quantos alunos e quantos têm cartão válido. */
  yearGroups(yearId: string) {
    return this.db.$queryRaw<{ id: string; label: string; classId: string; grade: number; courseId: string | null; courseName: string | null; shift: string; room: string | null; students: number; cards: number }[]>`
      SELECT g.id, g.name AS label, g.class_id AS "classId", c.grade, c.course_id AS "courseId", co.name AS "courseName", g.shift, g.room,
             (SELECT count(*)::int FROM enrollments e WHERE e.group_id = g.id AND e.status = 'ACTIVE') AS students,
             (SELECT count(*)::int FROM enrollments e JOIN student_cards sc ON sc.student_id = e.student_id AND sc.academic_year_id = g.academic_year_id AND sc.status = 'ACTIVE'
               WHERE e.group_id = g.id AND e.status = 'ACTIVE') AS cards
        FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE g.academic_year_id = ${yearId}::uuid
       ORDER BY c.grade, co.name NULLS FIRST, g.name`;
  }
  async group(groupId: string) {
    const [r] = await this.db.$queryRaw<{ id: string; label: string; yearId: string; yearName: string; grade: number; courseName: string | null }[]>`
      SELECT g.id, g.name AS label, g.academic_year_id AS "yearId", y.name AS "yearName", c.grade, co.name AS "courseName"
        FROM class_groups g JOIN school_classes c ON c.id = g.class_id JOIN academic_years y ON y.id = g.academic_year_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE g.id = ${groupId}::uuid`;
    return r ? { id: r.id, label: r.label, yearId: r.yearId, yearName: r.yearName, classLabel: classLabel(r.grade, r.courseName) } : null;
  }
  /** Os alunos da turma: a fotografia (se há e se se imprime) e o cartão válido deste ano. */
  async groupStudents(groupId: string, yearId: string) {
    const rows = await this.db.$queryRaw<
      { id: string; name: string; number: number | null; photoSource: string | null; photoMime: string | null; cardId: string | null; cardNumber: number | null; cardVersion: number | null; cardCode: string | null; cardAt: Date | null; cardModel: string | null; cards: number }[]
    >`
      SELECT s.id, s.full_name AS name, s.number, ph.source AS "photoSource", ph.mime_type AS "photoMime",
             ac.id AS "cardId", ac.number AS "cardNumber", ac.version AS "cardVersion", ac.code AS "cardCode", ac.created_at AS "cardAt", ac.model AS "cardModel",
             (SELECT count(*)::int FROM student_cards x WHERE x.student_id = s.id AND x.academic_year_id = ${yearId}::uuid) AS cards
        FROM enrollments e JOIN students s ON s.id = e.student_id
        ${PHOTO_LATERAL}
        LEFT JOIN student_cards ac ON ac.student_id = s.id AND ac.academic_year_id = ${yearId}::uuid AND ac.status = 'ACTIVE'
       WHERE e.group_id = ${groupId}::uuid AND e.status = 'ACTIVE'
       ORDER BY lower(s.full_name)`;
    return rows.map((r) => ({ ...r, number: formatStudentNumber(r.number) }));
  }
  /** O aluno para o cartão de um ano (o da turma onde se emite); sem ano, o ano em curso e, sem ele, a matrícula mais recente. */
  async target(studentId: string, yearId: string | null = null): Promise<CardTarget | null> {
    const [r] = await this.db.$queryRaw<{ id: string; name: string; number: number | null; status: string; yearId: string | null; yearName: string | null; endsOn: string | null; grade: number | null; courseName: string | null; groupName: string | null }[]>`
      SELECT s.id, s.full_name AS name, s.number, s.status, e.academic_year_id AS "yearId", y.name AS "yearName", to_char(y.ends_on, 'YYYY-MM-DD') AS "endsOn",
             c.grade, co.name AS "courseName", g.name AS "groupName"
        FROM students s
        LEFT JOIN LATERAL (SELECT e.* FROM enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id
                            WHERE e.student_id = s.id AND e.status = 'ACTIVE' ${yearId ? Prisma.sql`AND e.academic_year_id = ${yearId}::uuid` : Prisma.empty}
                            ORDER BY (ay.status = 'ACTIVE') DESC, e.enrolled_at DESC LIMIT 1) e ON true
        LEFT JOIN academic_years y ON y.id = e.academic_year_id LEFT JOIN school_classes c ON c.id = e.class_id LEFT JOIN courses co ON co.id = c.course_id
        LEFT JOIN class_groups g ON g.id = e.group_id
       WHERE s.id = ${studentId}::uuid`;
    if (!r) return null;
    return { id: r.id, name: r.name, number: formatStudentNumber(r.number), status: r.status, yearId: r.yearId, yearName: r.yearName, endsOn: r.endsOn, classLabel: classLabel(r.grade, r.courseName), groupName: r.groupName };
  }
  async photo(studentId: string): Promise<PhotoRow | null> {
    const [r] = await this.db.$queryRaw<{ source: "UPLOAD" | "APPLICATION"; storage_key: string; mime_type: string; file_name: string }[]>`
      SELECT ph.source, ph.storage_key, ph.mime_type, ph.file_name FROM students s ${PHOTO_LATERAL} WHERE s.id = ${studentId}::uuid AND ph.storage_key IS NOT NULL`;
    return r ? { source: r.source, storageKey: r.storage_key, mimeType: r.mime_type, fileName: r.file_name } : null;
  }
  async addPhoto(studentId: string, f: { fileName: string; mimeType: string; size: number; sha256: string; storageKey: string }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO student_photos (id, student_id, file_name, mime_type, size, sha256, storage_key, uploaded_by_id, uploaded_by_name, created_at)
      VALUES (${randomUUID()}::uuid, ${studentId}::uuid, ${f.fileName}, ${f.mimeType}, ${f.size}, ${f.sha256}, ${f.storageKey}, ${actor.id}::uuid, ${actor.name}, ${now})`;
  }

  // ================================================================ cartões

  async card(id: string): Promise<CardRow | null> {
    const [r] = await this.db.$queryRaw<CardRow[]>`${CARD_SQL} WHERE sc.id = ${id}::uuid`;
    return r ?? null;
  }
  cards(ids: string[]) {
    if (!ids.length) return Promise.resolve([] as CardRow[]);
    return this.db.$queryRaw<CardRow[]>`${CARD_SQL} WHERE sc.id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))}) ORDER BY lower(sc.data->>'name'), sc.version`;
  }
  studentCards(studentId: string) {
    return this.db.$queryRaw<CardRow[]>`${CARD_SQL} WHERE sc.student_id = ${studentId}::uuid ORDER BY sc.created_at DESC`;
  }
  async byCode(code: string): Promise<CardRow | null> {
    const [r] = await this.db.$queryRaw<CardRow[]>`${CARD_SQL} WHERE sc.code = ${code}`;
    return r ?? null;
  }
  async active(studentId: string, yearId: string): Promise<CardRow | null> {
    const [r] = await this.db.$queryRaw<CardRow[]>`${CARD_SQL} WHERE sc.student_id = ${studentId}::uuid AND sc.academic_year_id = ${yearId}::uuid AND sc.status = 'ACTIVE'`;
    return r ?? null;
  }
  /** Os cartões válidos dos alunos de uma turma (para imprimir a turma toda). */
  groupActive(groupId: string, yearId: string) {
    return this.db.$queryRaw<CardRow[]>`
      ${CARD_SQL} WHERE sc.academic_year_id = ${yearId}::uuid AND sc.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = sc.student_id AND e.group_id = ${groupId}::uuid AND e.status = 'ACTIVE')
      ORDER BY lower(sc.data->>'name')`;
  }
  /** Novo cartão (a versão seguinte do aluno nesse ano); o válido anterior fica substituído. */
  async add(c: { studentId: string; yearId: string; code: string; model: CardModel; data: CardData; validUntil: string; reason: string | null; requestId: string | null }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      UPDATE student_cards SET status = 'REPLACED', ended_at = ${now} WHERE student_id = ${c.studentId}::uuid AND academic_year_id = ${c.yearId}::uuid AND status = 'ACTIVE'`;
    const id = randomUUID();
    const [r] = await this.db.$queryRaw<{ number: number; version: number }[]>`
      INSERT INTO student_cards (id, student_id, academic_year_id, version, code, model, data, valid_until, status, reason, request_id, created_by_id, created_by_name, created_at)
      VALUES (${id}::uuid, ${c.studentId}::uuid, ${c.yearId}::uuid,
              (SELECT coalesce(max(version), 0) + 1 FROM student_cards WHERE student_id = ${c.studentId}::uuid AND academic_year_id = ${c.yearId}::uuid),
              ${c.code}, ${c.model}, ${JSON.stringify(c.data)}::jsonb, ${c.validUntil}::date, 'ACTIVE', ${c.reason}, ${c.requestId}::uuid, ${actor.id}::uuid, ${actor.name}, ${now})
      RETURNING number, version`;
    return { id, number: r.number, version: r.version };
  }
  /** Anula um cartão válido (perdido, roubado, saída do aluno). false = já não estava válido. */
  async revoke(id: string, reason: string, now: Date) {
    const n = await this.db.$executeRaw`UPDATE student_cards SET status = 'REVOKED', revoke_reason = ${reason}, ended_at = ${now} WHERE id = ${id}::uuid AND status = 'ACTIVE'`;
    return n === 1;
  }
}
