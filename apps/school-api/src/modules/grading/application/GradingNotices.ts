import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import type { PrismaGradebookRepository, TermKey } from "../infrastructure/prisma-gradebook";
import { gradeName } from "./GradingModels";

type Books = PrismaGradebookRepository;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);

/**
 * AVISOS DO FECHO DOS PERÍODOS — quem precisa de saber, no momento em que precisa:
 *   submetidas  → o diretor de turma e quem valida (nunca o próprio professor)
 *   devolvidas / reabertas → o professor da disciplina, com o motivo
 *   validadas   → quem publica
 *   publicadas  → as famílias da turma (o encarregado do aluno menor, ou o aluno maior com conta)
 * Um aviso que falhe nunca desfaz o que se fez (quem chama apanha o erro).
 */
export class GradingNotices {
  constructor(private readonly clock: Clock) {}

  private async context(books: Books, k: TermKey) {
    const book = await books.book(k.groupId, k.subjectId);
    if (!book) return null;
    const period = periodName(book.periodKind as PeriodKind, k.period);
    const where = `${gradeName(book.grade, book.courseName)} · Turma ${book.groupName}`;
    const q = `turma=${k.groupId}&disciplina=${k.subjectId}&periodo=${k.period}`;
    return { book, period, where, q };
  }

  async submitted(books: Books, notify: StaffNotify, k: TermKey) {
    const c = await this.context(books, k);
    if (!c) return;
    const [coordinator, validators, teacherUser] = await Promise.all([books.coordinatorUser(k.groupId), books.usersWith("grading.results.validate"), c.book.teacherId ? books.userOfEmployee(c.book.teacherId) : null]);
    const title = `${c.book.subjectName}, ${c.period}: classificações para validar`;
    const body = `${c.book.teacherName ?? "O professor"} submeteu as classificações de ${c.book.subjectName} (${c.where}, ${c.period}).`;
    const key = `grades-submitted:${k.groupId}:${k.subjectId}:${k.period}:${this.clock.now().toISOString()}`;
    if (coordinator && coordinator !== teacherUser) await notify.notify({ kind: "GRADES_SUBMITTED", userIds: [coordinator], title, body, link: `/caderneta?${c.q}`, dedupeKey: key });
    const staff = validators.map((u) => u.id).filter((id) => id !== coordinator && id !== teacherUser);
    if (staff.length) await notify.notify({ kind: "GRADES_SUBMITTED", userIds: staff, title, body, link: `/pedagogico/cadernetas?${c.q}`, dedupeKey: key });
  }

  async returned(books: Books, notify: StaffNotify, k: TermKey, reopened: boolean, reason: string | null) {
    const c = await this.context(books, k);
    if (!c?.book.teacherId) return;
    await notify.notify({
      kind: "GRADES_RETURNED",
      employeeIds: [c.book.teacherId],
      title: `${c.book.subjectName}, ${c.period}: classificações ${reopened ? "reabertas para retificação" : "devolvidas"}`,
      body: `${reopened ? "A direção reabriu" : "Foram-lhe devolvidas"} as classificações de ${c.book.subjectName} (${c.where}, ${c.period})${reason ? `. Motivo: ${reason}` : ""}. Corrija e submeta outra vez.`,
      link: `/caderneta?${c.q}`,
      dedupeKey: `grades-returned:${k.groupId}:${k.subjectId}:${k.period}:${this.clock.now().toISOString()}`,
    });
  }

  async validated(books: Books, notify: StaffNotify, k: TermKey) {
    const c = await this.context(books, k);
    if (!c) return;
    const publishers = (await books.usersWith("grading.results.publish")).map((u) => u.id);
    if (!publishers.length) return;
    await notify.notify({
      kind: "GRADES_VALIDATED",
      userIds: publishers,
      title: `${c.where}, ${c.period}: classificações por publicar`,
      body: `As classificações de ${c.book.subjectName} foram validadas: falta publicá-las para as famílias.`,
      link: `/pedagogico/classificacoes?periodo=${k.period}`,
      dedupeKey: `grades-validated:${k.groupId}:${k.subjectId}:${k.period}:${this.clock.now().toISOString()}`,
    });
  }

  /** Avisa as famílias da turma (uma notificação por aluno e conta, com as disciplinas publicadas). */
  async published(books: Books, groupId: string, period: number, subjects: { id: string; name: string; number: number }[]) {
    if (!subjects.length) return 0;
    const c = await this.context(books, { yearId: "", groupId, subjectId: subjects[0].id, period });
    if (!c) return 0;
    const rectified = subjects.some((s) => s.number > 1);
    const title = rectified ? `Classificações retificadas: ${c.period}` : `Classificações publicadas: ${c.period}`;
    const body = `${rectified ? "Foram retificadas" : "Já pode ver"} as classificações do ${c.period} de ${subjects.map((s) => s.name).join(", ")}.`;
    const now = this.clock.now();
    return books.notifyFamilies(groupId, "STUDENT_GRADES", title, body, "/familia/classificacoes?aluno=", today(now), now);
  }
}
