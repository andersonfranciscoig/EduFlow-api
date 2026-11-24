import { PRESENCE_LABELS, type PresenceStatus } from "./presence";

/**
 * RESUMO DIÁRIO — um por pessoa e por dia de aulas, 1 hora depois da última aula prevista dessa pessoa.
 *   equipa   as aulas do professor e, se for diretor de turma, a assiduidade das turmas que coordena
 *   família  o dia de cada aluno a que a conta tem acesso
 * Aqui só se compõe o texto, a partir dos dados do dia; quando e a quem decide-se na tarefa.
 */
export const DIGEST_DELAY_MINUTES = 60;
/** Se a tarefa esteve parada, ainda envia o que ficou devido há menos destas horas (depois já não interessa). */
export const DIGEST_WINDOW_HOURS = 18;

export type Tone = "ok" | "warn" | "danger" | "info";
export interface DigestItem {
  text: string;
  tone: Tone;
}
export interface DigestSection {
  title: string;
  items: DigestItem[];
  /** na família: de que aluno é (ao ler confirma-se que a conta ainda lhe tem acesso) */
  studentId?: string;
}
export interface DigestContent {
  headline: string;
  sections: DigestSection[];
}

export interface TeacherLesson {
  startsAt: string;
  endsAt: string;
  groupName: string;
  subjectName: string;
  substitution: boolean;
  session: { late: boolean; summary: boolean; present: number; absent: number; lateN: number; justified: number; total: number } | null;
}
export interface DayNotice {
  title: string;
  /** quantas vezes o mesmo aviso chegou nesse dia */
  times: number;
}
export interface GroupDay {
  groupName: string;
  lessons: { startsAt: string; subjectName: string; teacherName: string | null; registered: boolean }[];
  marks: { studentId: string; fullName: string; status: PresenceStatus; minutesLate: number | null; subjectName: string }[];
  /** faltas seguidas atuais de quem faltou hoje */
  streaks: Map<string, number>;
  alerts: { fullName: string; rule: string; count: number }[];
}
export interface StudentDay {
  studentId: string;
  fullName: string;
  groupName: string;
  lessons: { startsAt: string; subjectName: string; registered: boolean; status: PresenceStatus | null; minutesLate: number | null; summary: string | null }[];
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const first = (name: string) => name.split(" ").slice(0, 2).join(" ");

const noticeItems = (list: DayNotice[]): DigestItem[] => list.map((x) => ({ text: x.times > 1 ? `${x.title} (×${x.times})` : x.title, tone: "info" }));

function teacherSections(lessons: TeacherLesson[]): { sections: DigestSection[]; done: number; pending: number } {
  const done = lessons.filter((l) => l.session);
  const pending = lessons.filter((l) => !l.session);
  const sections: DigestSection[] = [];
  if (done.length)
    sections.push({
      title: `Aulas com presenças registadas (${done.length})`,
      items: done.map((l) => {
        const s = l.session!;
        const parts = [n(s.present, "presente", "presentes"), ...(s.absent ? [n(s.absent, "ausente", "ausentes")] : []), ...(s.lateN ? [n(s.lateN, "atrasado", "atrasados")] : []), ...(s.justified ? [n(s.justified, "falta justificada", "faltas justificadas")] : [])];
        return { text: `${l.startsAt} · ${l.subjectName} · ${l.groupName}${l.substitution ? " (substituição)" : ""}: ${parts.join(", ")}${s.late ? " · fora do prazo" : ""}${s.summary ? "" : " · sem sumário"}`, tone: s.late || !s.summary ? ("warn" as const) : ("ok" as const) };
      }),
    });
  if (pending.length)
    sections.push({ title: `Presenças por registar (${pending.length})`, items: pending.map((l) => ({ text: `${l.startsAt} · ${l.subjectName} · ${l.groupName}${l.substitution ? " (substituição)" : ""}`, tone: "danger" as const })) });
  return { sections, done: done.length, pending: pending.length };
}

function groupSection(g: GroupDay, consecutiveLimit: number): DigestSection {
  const registered = g.lessons.filter((l) => l.registered).length;
  const items: DigestItem[] = [];
  const c = { present: 0, absent: 0, late: 0, justified: 0 };
  for (const m of g.marks) c[({ PRESENTE: "present", AUSENTE: "absent", ATRASADO: "late", FALTA_JUSTIFICADA: "justified" } as const)[m.status]]++;
  const total = g.marks.length;
  const rate = total ? Math.round(((c.present + c.late) / total) * 1000) / 10 : null;
  items.push({ text: `${registered} de ${n(g.lessons.length, "aula", "aulas")} com presenças${rate === null ? "" : ` · assiduidade de ${rate.toLocaleString("pt-PT")}%`}`, tone: registered === g.lessons.length ? "ok" : "warn" });
  const of = (status: PresenceStatus) => {
    const by = new Map<string, { name: string; count: number }>();
    for (const m of g.marks) if (m.status === status) by.set(m.studentId, { name: m.fullName, count: (by.get(m.studentId)?.count ?? 0) + 1 });
    return by;
  };
  const absents = of("AUSENTE");
  if (absents.size) items.push({ text: `Com faltas: ${[...absents.values()].map((x) => `${first(x.name)} (${x.count})`).join(", ")}`, tone: "danger" });
  const lates = of("ATRASADO");
  if (lates.size) items.push({ text: `Com atrasos: ${[...lates.values()].map((x) => `${first(x.name)} (${x.count})`).join(", ")}`, tone: "warn" });
  const streaks = [...absents.entries()].map(([id, x]) => ({ name: x.name, count: g.streaks.get(id) ?? 0 })).filter((x) => x.count >= consecutiveLimit);
  if (streaks.length) items.push({ text: `Faltas seguidas: ${streaks.map((x) => `${first(x.name)} (${x.count})`).join(", ")}`, tone: "danger" });
  const missing = new Map<string, number>();
  for (const l of g.lessons) if (!l.registered) missing.set(`${l.teacherName ?? "Sem professor"} (${l.subjectName})`, (missing.get(`${l.teacherName ?? "Sem professor"} (${l.subjectName})`) ?? 0) + 1);
  if (missing.size) items.push({ text: `Professores com presenças por registar: ${[...missing.entries()].map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ""}`).join(", ")}`, tone: "warn" });
  for (const a of g.alerts) items.push({ text: `Alerta de hoje: ${first(a.fullName)} — ${a.rule === "STREAK" ? `${a.count} faltas seguidas` : `chegou a ${a.count} faltas`}`, tone: "danger" });
  return { title: `Turma ${g.groupName}`, items };
}

/** O resumo de um professor e/ou diretor de turma. */
export function staffDigest(d: { lessons: TeacherLesson[]; groups: GroupDay[]; notices: DayNotice[]; consecutiveLimit: number }): DigestContent {
  const t = teacherSections(d.lessons);
  const sections = [...t.sections, ...d.groups.map((g) => groupSection(g, d.consecutiveLimit))];
  if (d.notices.length) sections.push({ title: "Outros avisos de hoje", items: noticeItems(d.notices) });
  const parts = [
    ...(d.lessons.length ? [`${n(d.lessons.length, "aula", "aulas")}: ${n(t.done, "registada", "registadas")}${t.pending ? `, ${t.pending} por registar` : ""}`] : []),
    ...d.groups.map((g) => {
      const absent = new Set(g.marks.filter((m) => m.status === "AUSENTE").map((m) => m.studentId)).size;
      return `turma ${g.groupName}: ${absent ? n(absent, "aluno com faltas", "alunos com faltas") : "sem faltas registadas"}`;
    }),
  ];
  return { headline: parts.join(" · "), sections };
}

/** O resumo de uma conta da família: um bloco por aluno. */
export function familyDigest(d: { students: StudentDay[]; notices: DayNotice[] }): DigestContent {
  const sections: DigestSection[] = d.students.map((s) => ({
    studentId: s.studentId,
    title: d.students.length > 1 ? `${first(s.fullName)} · turma ${s.groupName}` : `Turma ${s.groupName}`,
    items: s.lessons.map((l) => {
      const state = !l.registered ? "presenças por registar" : l.status ? `${PRESENCE_LABELS[l.status]}${l.status === "ATRASADO" && l.minutesLate ? ` (${l.minutesLate} min)` : ""}` : "sem registo";
      const tone: Tone = l.status === "AUSENTE" ? "danger" : l.status === "ATRASADO" ? "warn" : l.status === "PRESENTE" ? "ok" : "info";
      return { text: `${l.startsAt} · ${l.subjectName}: ${state}${l.summary ? ` — sumário: ${l.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`, tone };
    }),
  }));
  if (d.notices.length) sections.push({ title: "Outros avisos de hoje", items: noticeItems(d.notices) });
  const line = (s: StudentDay) => {
    const absent = s.lessons.filter((l) => l.status === "AUSENTE").length;
    const late = s.lessons.filter((l) => l.status === "ATRASADO").length;
    const registered = s.lessons.filter((l) => l.registered).length;
    const what = [...(absent ? [n(absent, "falta", "faltas")] : []), ...(late ? [n(late, "atraso", "atrasos")] : [])].join(" e ") || "sem faltas nem atrasos";
    return `${d.students.length > 1 ? `${first(s.fullName)}: ` : ""}${what} (${registered} de ${n(s.lessons.length, "aula registada", "aulas registadas")})`;
  };
  return { headline: d.students.map(line).join(" · "), sections };
}
