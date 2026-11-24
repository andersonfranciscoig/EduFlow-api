import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { ok } from "../../../../../../libs/kernel/src/domain/Result";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import { PRESENCE_LABELS, type PresenceStatus, rate } from "../domain/presence";
import type { AttendanceRules } from "../domain/settings";
import type { PrismaStudentAttendanceRepository, StandingRow } from "../infrastructure/prisma-student-attendance";

/** Envia um aviso à área da família (a implementação vive no módulo da família). */
export type FamilyNotify = (n: { accountId: string; kind: string; title: string; body: string; link: string; studentId: string; now: Date }) => Promise<void>;

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const firstNames = (n: string) => n.split(" ").slice(0, 2).join(" ");

/** Idade em anos completos num dia ("AAAA-MM-DD"). */
export function ageOn(birthDate: string, day: string) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * As faltas seguidas atuais: as faltas (não justificadas) desde a última aula em que o aluno
 * esteve (a falta justificada não quebra nem soma). Devolve também a 1.ª falta da sequência.
 */
export function currentStreak(marks: StandingRow["marks"]) {
  let n = 0;
  let first: { day: string; startsAt: string } | null = null;
  for (const m of marks) {
    if (m.status === "AUSENTE") {
      n++;
      first = { day: m.day, startsAt: m.startsAt };
    } else if (m.status !== "FALTA_JUSTIFICADA") break;
  }
  return { n, first };
}

/**
 * ALERTAS DE ASSIDUIDADE (fase P5). Depois de registar ou corrigir as presenças de uma aula, para
 * cada aluno que faltou: se chegou ao limite de faltas ou de faltas seguidas das regras do colégio,
 * avisa (uma vez por limite) o diretor de turma e a família — o encarregado que o gere se é menor,
 * o próprio aluno se é maior e tem conta. A mesma regra do acesso na área da família (canAccessStudent):
 * só o encarregado que gere o aluno, e só enquanto é menor; um aluno maior sem conta não tem destinatário.
 */
export class StudentAlerts {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async afterSession(repo: PrismaStudentAttendanceRepository, rules: AttendanceRules, sessionId: string, today: string, notify?: StaffNotify, family?: FamilyNotify) {
    const info = await repo.sessionInfo(sessionId);
    if (!info || !info.absentIds.length) return { alerts: 0 };
    const now = this.clock.now();
    let sent = 0;
    for (const s of await repo.standing(info.groupId, info.absentIds)) {
      const streak = currentStreak(s.marks);
      const hits: { rule: "ABSENCES" | "STREAK"; key: string; count: number; text: string }[] = [];
      if (s.absent >= rules.absenceLimit) hits.push({ rule: "ABSENCES", key: `absences:${info.groupId}:${rules.absenceLimit}`, count: s.absent, text: `chegou a ${s.absent} faltas não justificadas (o limite do colégio é ${rules.absenceLimit})` });
      if (streak.first && streak.n >= rules.consecutiveLimit)
        hits.push({ rule: "STREAK", key: `streak:${info.groupId}:${streak.first.day}T${streak.first.startsAt}:${rules.consecutiveLimit}`, count: streak.n, text: `tem ${streak.n} faltas seguidas, desde ${dmy(streak.first.day)}` });
      for (const h of hits) {
        const id = this.ids.next();
        if (!(await repo.saveAlert({ id, studentId: s.id, groupId: info.groupId, rule: h.rule, key: h.key, count: h.count, sessionId, now }))) continue;
        sent++;
        await repo.record("STUDENT_ATTENDANCE_ALERT", s.id, null, { rule: h.rule, count: h.count, groupId: info.groupId, sessionId }, now);
        if (info.coordinatorId)
          await notify?.notify({
            kind: "ATTENDANCE_ALERT",
            employeeIds: [info.coordinatorId],
            title: `Alerta de assiduidade · ${s.fullName} (${info.groupName})`,
            body: `${firstNames(s.fullName)} ${h.text}.`,
            link: `/presencas/coordenacao?turma=${info.groupId}`,
            dedupeKey: `attendance-alert:${id}`,
          });
        if (family) {
          const adult = ageOn(s.birthDate, today) >= 18;
          const to = adult ? (s.accountId ? [s.accountId] : []) : await repo.guardianAccounts(s.id);
          for (const accountId of to)
            await family({
              accountId,
              kind: "STUDENT_ATTENDANCE_ALERT",
              title: adult ? "Alerta de assiduidade" : `Alerta de assiduidade · ${firstNames(s.fullName)}`,
              body: `${adult ? "Na turma " + info.groupName + ", " : firstNames(s.fullName) + " (" + info.groupName + ") "}${h.text}. Veja o detalhe em Assiduidade.`,
              link: `/familia/assiduidade?aluno=${s.id}`,
              studentId: s.id,
              now,
            });
        }
      }
    }
    return { alerts: sent };
  }

  /** A assiduidade de um aluno para a família (o acesso ao aluno e a turma confirmam-se antes). */
  async familyView(repo: PrismaStudentAttendanceRepository, rules: AttendanceRules, studentId: string, groupId: string) {
    const [group, subjects, events, [standing], alerts] = await Promise.all([repo.group(groupId), repo.subjects(groupId, studentId), repo.events(groupId, studentId, 60), repo.standing(groupId, [studentId]), repo.alerts(groupId, studentId)]);
    const totals = subjects.reduce(
      (a, s) => ({ present: a.present + s.counts.present, absent: a.absent + s.counts.absent, late: a.late + s.counts.late, justified: a.justified + s.counts.justified, total: a.total + s.counts.total }),
      { present: 0, absent: 0, late: 0, justified: 0, total: 0 },
    );
    const streak = standing ? currentStreak(standing.marks).n : 0;
    return ok({
      group,
      rules: { absenceLimit: rules.absenceLimit, consecutiveLimit: rules.consecutiveLimit },
      totals: { ...totals, rate: rate(totals) },
      streak,
      warnings: [
        ...(totals.absent >= rules.absenceLimit ? [`${totals.absent} faltas não justificadas (o limite do colégio é ${rules.absenceLimit}).`] : []),
        ...(streak >= rules.consecutiveLimit ? [`${streak} faltas seguidas.`] : []),
      ],
      subjects: subjects.map((s) => ({ ...s, rate: rate(s.counts) })),
      events: events.map((e) => ({ ...e, statusLabel: PRESENCE_LABELS[e.status as PresenceStatus] })),
      alerts: alerts.map((a) => ({ rule: a.rule, count: a.count, label: a.rule === "ABSENCES" ? `Chegou a ${a.count} faltas` : `${a.count} faltas seguidas`, createdAt: a.createdAt.toISOString() })),
    });
  }
}
