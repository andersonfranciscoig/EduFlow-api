import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import type { PrismaExamsRepository } from "../infrastructure/prisma-exams";

/**
 * Entrega os avisos do calendário de provas (publicação, alterações, cancelamentos) a professores e
 * famílias. Cada aviso foi gravado com a alteração; aqui reserva-se e entrega-se, uma vez a cada um:
 * a família numa só instrução (marcada como entregue na mesma) e a equipa com chave única. Corre a
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
          const employeeIds = await repo.noticeEmployees(n);
          if (employeeIds.length) stats.staff += (await notify.notify({ kind: "EXAMS", employeeIds, title: n.title, body: n.body, link: "/provas", dedupeKey: `exams:${n.id}` })).delivered;
          await repo.staffSent(n.id, now);
        }
      } catch (e) {
        stats.errors++;
        await repo.noticeError(n.id, String((e as Error).message)).catch(() => undefined);
      }
    }
    return stats;
  }
}
