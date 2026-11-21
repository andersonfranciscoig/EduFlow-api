import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { FORMAT_MIME, MB, safeFileName, sniffFormat } from "../../hr/domain/employee";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import { checkReason, cleanText, KIND_LABELS, type OccurrenceKind, STATUS_LABELS } from "../domain/occurrences";
import { type AttendanceError, attendanceError } from "../domain/settings";
import type { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import type { JustificationRow, PrismaJustificationsRepository } from "../infrastructure/prisma-justifications";
import type { OccurrencesRepository } from "./occurrence-ports";
import { occurrenceDto, type TeacherOccurrences } from "./TeacherOccurrences";

type R<T> = Promise<Result<T, AttendanceError>>;
const PROOF_MAX_MB = 10;
/** os formatos de sniffFormat (em minúsculas) aceites como comprovativo */
const FORMATS = ["pdf", "jpg", "png"];
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const JUSTIFICATION_LABELS = { PENDING: "Em análise", APPROVED: "Aceite", REJECTED: "Não aceite" } as const;

const what = (j: Pick<JustificationRow, "kind" | "minutesLate" | "scope" | "startsAt" | "subjectName" | "groupName" | "day">) =>
  `${j.kind === "ATRASO" ? `Atraso de ${j.minutesLate} min` : KIND_LABELS[j.kind as OccurrenceKind] ?? j.kind} a ${dmy(j.day)}${j.scope === "LESSON" ? ` (${j.startsAt} ${j.subjectName ?? ""}, ${j.groupName ?? ""})` : " (o dia)"}`;

export const justificationDto = (j: JustificationRow) => ({
  id: j.id,
  occurrenceId: j.occurrenceId,
  teacher: { id: j.employeeId, fullName: j.teacherName },
  reason: j.reason,
  proof: j.proof ? { name: j.proof.name, mimeType: j.proof.mimeType, size: j.proof.size } : null,
  status: j.status,
  statusLabel: JUSTIFICATION_LABELS[j.status],
  decisionNote: j.decisionNote,
  decidedBy: j.decidedByName,
  decidedAt: j.decidedAt?.toISOString() ?? null,
  createdAt: j.createdAt.toISOString(),
  occurrence: { id: j.occurrenceId, day: j.day, kind: j.kind, minutesLate: j.minutesLate, scope: j.scope, subjectName: j.subjectName, groupName: j.groupName, startsAt: j.startsAt, status: j.occurrenceStatus, statusLabel: STATUS_LABELS[j.occurrenceStatus as keyof typeof STATUS_LABELS] ?? j.occurrenceStatus, source: j.source, label: what(j) },
});

/**
 * Justificações das faltas dos professores.
 *  O professor (conta ligada ao funcionário) vê as suas faltas e atrasos e justifica os que estão
 *  por justificar: motivo e, se quiser, um comprovativo (PDF/JPG/PNG até 10 MB, cifrado no
 *  armazenamento do RH). Enquanto está em análise pode retirá-la.
 *  O RH (attendance.teachers.manage) aceita — a ocorrência fica justificada (histórico, registo
 *  diário, aviso) — ou não aceita, com uma nota; o professor pode voltar a justificar.
 */
export class Justifications {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly occurrences: TeacherOccurrences,
  ) {}

  private async me(repo: PrismaJustificationsRepository, userId: string): R<{ id: string; fullName: string }> {
    const e = await repo.employeeOfUser(userId);
    return e ? ok(e) : fail(attendanceError("FORBIDDEN", "A sua conta não está ligada a um funcionário."));
  }

  /** As minhas faltas e atrasos (com as justificações). */
  async mine(repo: PrismaJustificationsRepository, occ: OccurrencesRepository, userId: string) {
    const me = await this.me(repo, userId);
    if (!me.ok) return me;
    const list = await occ.list({ employeeId: me.value.id, page: 1, pageSize: 100 });
    const js = await repo.forOccurrences(list.items.map((o) => o.id));
    return ok({
      teacher: me.value,
      counts: { open: list.items.filter((o) => o.status === "REGISTADA").length, justified: list.items.filter((o) => o.status === "JUSTIFICADA").length, pending: js.filter((j) => j.status === "PENDING").length },
      items: list.items.map((o) => {
        const mine = js.filter((j) => j.occurrenceId === o.id);
        const pending = mine.find((j) => j.status === "PENDING");
        return { ...occurrenceDto(o), canJustify: o.status === "REGISTADA" && !pending, justifications: mine.map(justificationDto) };
      }),
    });
  }

  async submit(
    repo: PrismaJustificationsRepository,
    occ: OccurrencesRepository,
    files: HrFileStore,
    userId: string,
    occurrenceId: string,
    input: { reason: string; file?: { originalname: string; buffer: Buffer } },
    hr: PrismaDeadlineRepository,
    notify?: StaffNotify,
  ): R<ReturnType<typeof justificationDto>> {
    const me = await this.me(repo, userId);
    if (!me.ok) return me;
    const o = await occ.find(occurrenceId);
    if (!o || o.employeeId !== me.value.id) return fail(attendanceError("NOT_FOUND", "Ocorrência não encontrada."));
    if (o.status !== "REGISTADA") return fail(attendanceError("INVALID_STATE", `Esta ocorrência já está ${STATUS_LABELS[o.status].toLowerCase()}.`));
    const reason = checkReason(input.reason, "o motivo", 500);
    if (!reason.ok) return reason;
    let proof: { name: string; mimeType: string; size: number; sha256: string; storageKey: string } | null = null;
    if (input.file?.buffer?.length) {
      if (!files.ready) return fail(attendanceError("INVALID_STATE", "O envio de ficheiros ainda não está disponível neste colégio. Justifique sem comprovativo ou fale com o RH."));
      if (input.file.buffer.length > PROOF_MAX_MB * MB) return fail(attendanceError("INVALID_INPUT", `O ficheiro tem mais de ${PROOF_MAX_MB} MB.`));
      const format = sniffFormat(input.file.buffer, input.file.originalname);
      if (!format || !FORMATS.includes(format)) return fail(attendanceError("INVALID_INPUT", "Formato não aceite. Envie PDF, JPG ou PNG."));
      const name = safeFileName(input.file.originalname, format);
      try {
        const stored = await files.save(`hr-${me.value.id}`, { fileName: name, mimeType: FORMAT_MIME[format], content: input.file.buffer });
        proof = { name, mimeType: FORMAT_MIME[format], size: input.file.buffer.length, sha256: sha256(input.file.buffer), storageKey: stored.key };
      } catch {
        return fail(attendanceError("INVALID_STATE", "Não foi possível guardar o ficheiro agora. Tente de novo dentro de instantes."));
      }
    }
    const id = this.ids.next();
    const now = this.clock.now();
    if (!(await repo.create({ id, occurrenceId, employeeId: me.value.id, reason: reason.value, proof, actorId: userId, now }))) {
      if (proof) await files.remove(proof.storageKey).catch(() => undefined);
      return fail(attendanceError("OCCURRENCE_EXISTS", "Já há uma justificação em análise para esta ocorrência."));
    }
    await occ.record("TEACHER_OCCURRENCE_JUSTIFICATION_SUBMITTED", occurrenceId, userId, { reason: reason.value, justificationId: id, proof: !!proof }, now);
    const j = (await repo.find(id))!;
    await notify?.notify({
      kind: "JUSTIFICATION_SUBMITTED",
      userIds: await hr.hrUserIds(),
      title: `Justificação de ${me.value.fullName}`,
      body: `${what(j)}: ${reason.value}${proof ? " (com comprovativo)" : ""}`,
      link: `/rh/faltas-professores/${occurrenceId}`,
      dedupeKey: `justification:${id}`,
    });
    return ok(justificationDto(j));
  }

  async withdraw(repo: PrismaJustificationsRepository, occ: OccurrencesRepository, files: HrFileStore, userId: string, id: string): R<{ withdrawn: true }> {
    const me = await this.me(repo, userId);
    if (!me.ok) return me;
    const j = await repo.find(id);
    if (!j || j.employeeId !== me.value.id) return fail(attendanceError("NOT_FOUND", "Justificação não encontrada."));
    const r = await repo.withdraw(id, me.value.id);
    if (!r) return fail(attendanceError("INVALID_STATE", "Esta justificação já foi analisada."));
    if (r.key) await files.remove(r.key).catch(() => undefined);
    await occ.record("TEACHER_OCCURRENCE_JUSTIFICATION_WITHDRAWN", j.occurrenceId, userId, { reason: j.reason }, this.clock.now());
    return ok({ withdrawn: true });
  }

  /** O comprovativo: do próprio professor, ou para quem consulta as faltas dos professores. */
  async proof(repo: PrismaJustificationsRepository, files: HrFileStore, viewer: { userId: string; canView: boolean }, id: string) {
    const j = await repo.find(id);
    if (!j?.proof) return fail(attendanceError("NOT_FOUND", "Sem comprovativo."));
    if (!viewer.canView) {
      const me = await repo.employeeOfUser(viewer.userId);
      if (!me || me.id !== j.employeeId) return fail(attendanceError("NOT_FOUND", "Sem comprovativo."));
    }
    return ok({ fileName: j.proof.name, mimeType: j.proof.mimeType, content: await files.read(j.proof.storageKey), occurrenceId: j.occurrenceId });
  }

  // ============================================================ RH

  async list(repo: PrismaJustificationsRepository, input: { status?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const [r, counts] = await Promise.all([repo.list({ status: input.status && input.status in JUSTIFICATION_LABELS ? input.status : undefined, page, pageSize: 25 }), repo.counts()]);
    return { page, pageSize: 25, total: r.total, counts, items: r.items.map(justificationDto), statuses: Object.entries(JUSTIFICATION_LABELS).map(([value, label]) => ({ value, label })) };
  }

  async forOccurrence(repo: PrismaJustificationsRepository, occurrenceId: string) {
    return (await repo.forOccurrences([occurrenceId])).map(justificationDto);
  }

  /** Aceitar: a ocorrência fica justificada com o motivo do professor (e a nota do RH, se houver). */
  async approve(repo: PrismaJustificationsRepository, occ: OccurrencesRepository, actor: { id: string; canManage: boolean }, id: string, note: string | null, notify?: StaffNotify): R<{ approved: true }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para decidir justificações."));
    const j = await repo.find(id);
    if (!j) return fail(attendanceError("NOT_FOUND", "Justificação não encontrada."));
    if (j.status !== "PENDING") return fail(attendanceError("INVALID_STATE", "Esta justificação já foi analisada."));
    const extra = cleanText(note).slice(0, 300) || null;
    const text = `${j.reason}${extra ? ` — RH: ${extra}` : ""}`.slice(0, 500);
    const done = await this.occurrences.act(occ, actor, j.occurrenceId, "JUSTIFY", { reason: text }, notify);
    if (!done.ok) return done;
    await repo.decide(id, "APPROVED", extra, actor.id, this.clock.now());
    return ok({ approved: true });
  }

  /** Não aceitar: com a nota (obrigatória); a ocorrência fica por justificar e o professor é avisado. */
  async reject(repo: PrismaJustificationsRepository, occ: OccurrencesRepository, actor: { id: string; canManage: boolean }, id: string, note: string, notify?: StaffNotify): R<{ rejected: true }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para decidir justificações."));
    const n = checkReason(note, "o motivo", 300);
    if (!n.ok) return n;
    const j = await repo.find(id);
    if (!j) return fail(attendanceError("NOT_FOUND", "Justificação não encontrada."));
    const now = this.clock.now();
    if (!(await repo.decide(id, "REJECTED", n.value, actor.id, now))) return fail(attendanceError("INVALID_STATE", "Esta justificação já foi analisada."));
    await occ.record("TEACHER_OCCURRENCE_JUSTIFICATION_REJECTED", j.occurrenceId, actor.id, { reason: n.value, justification: j.reason }, now);
    await notify?.notify({
      kind: "TEACHER_OCCURRENCE",
      employeeIds: [j.employeeId],
      title: `Justificação não aceite: ${what(j)}`,
      body: `Motivo: ${n.value}. Pode voltar a justificar em As minhas faltas.`,
      link: "/as-minhas-faltas",
    });
    return ok({ rejected: true });
  }
}
