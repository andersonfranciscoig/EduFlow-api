import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import { dmy } from "../domain/exams";
import type { DutyRow, NoticeRow, PrismaExamsRepository } from "../infrastructure/prisma-exams";

const line = (d: DutyRow) => `${dmy(d.day)} às ${d.startsAt}: ${d.subjectName} (${d.groupLabel}${d.room ? `, sala ${d.room.replace(/^sala\s+/i, "")}` : ""})`;
/** As primeiras provas no corpo do aviso; o resto fica na página (e, por email, na lista completa). */
const short = (list: DutyRow[]) => `${list.slice(0, 5).map(line).join("; ")}${list.length > 5 ? `; e mais ${list.length - 5}` : ""}.`;

/**
 * Entrega os avisos do calendário de provas (publicação, alterações, cancelamentos, vigilância) a
 * professores e famílias. Cada aviso foi gravado com a alteração; aqui reserva-se e entrega-se, uma vez a
 * cada um: a família numa só instrução (marcada como entregue na mesma) e a equipa com chave única. Corre a
 * seguir a cada alteração e em cada volta do ciclo automático (que retoma o que falhar, até 5 vezes).
 */
export class ExamNotices {
  async deliver(repo: PrismaExamsRepository, notify: StaffNotify, today: string, now: Date) {
    const stats = { notices: 0, family: 0, staff: 0, errors: 0 };
    for (const n of await repo.claimNotices(now)) {
      stats.notices++;
      try {
        if (!n.family_sent) stats.family += await repo.sendFamily(n.id, "STUDENT_EXAMS", "/familia/provas?aluno=", today, now);
        if (!n.staff_sent) {
          stats.staff += await this.staff(repo, notify, n);
          await repo.staffSent(n.id, now);
        }
      } catch (e) {
        stats.errors++;
        await repo.noticeError(n.id, String((e as Error).message)).catch(() => undefined);
      }
    }
    return stats;
  }

  private async staff(repo: PrismaExamsRepository, notify: StaffNotify, n: NoticeRow) {
    if (n.kind === "INVIGILATION") {
      return n.teacher_ids.length ? (await notify.notify({ kind: "EXAM_INVIGILATION", employeeIds: n.teacher_ids, title: n.title, body: n.body, link: "/provas?vista=vigilancias", dedupeKey: `exams:${n.id}` })).delivered : 0;
    }
    const employeeIds = await repo.noticeEmployees(n);
    if (n.kind !== "PUBLISHED") return employeeIds.length ? (await notify.notify({ kind: "EXAMS", employeeIds, title: n.title, body: n.body, link: "/provas", dedupeKey: `exams:${n.id}` })).delivered : 0;

    // publicação: a cada professor, as datas das suas provas; a cada vigilante, as que vai vigiar
    let delivered = 0;
    const duties = await repo.duties(n.season_id, n.group_ids);
    for (const id of employeeIds) {
      const mine = duties.filter((d) => d.employeeId === id && d.duty === "SUBJECT");
      const r = await notify.notify({
        kind: "EXAMS",
        employeeIds: [id],
        title: n.title,
        body: mine.length ? `${n.body} As suas provas: ${short(mine)}` : n.body,
        link: mine.length ? "/provas" : "/provas?vista=turmas",
        dedupeKey: `exams:${n.id}`,
        sections: mine.length ? [{ title: "As provas das suas disciplinas", lines: mine.map(line) }] : undefined,
      });
      delivered += r.delivered;
    }
    for (const id of new Set(duties.filter((d) => d.duty === "INVIGILATION").map((d) => d.employeeId))) {
      const mine = duties.filter((d) => d.employeeId === id && d.duty === "INVIGILATION");
      const r = await notify.notify({
        kind: "EXAM_INVIGILATION",
        employeeIds: [id],
        title: mine.length === 1 ? "Vai vigiar uma prova" : `Vai vigiar ${mine.length} provas`,
        body: `${n.title.replace(/^[^:]*:\s*/, "")}: ${short(mine)}`,
        link: "/provas?vista=vigilancias",
        dedupeKey: `exams-vig:${n.id}`,
        sections: [{ title: "Vigilâncias", lines: mine.map(line) }],
      });
      delivered += r.delivered;
    }
    return delivered;
  }
}
