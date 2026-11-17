import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import {
  ATTENDANCE_STATUS_KEYS,
  ATTENDANCE_STATUSES,
  type AttendanceEntry,
  attendanceTotals,
  checkDay,
  checkEntry,
  dayLabel,
  isMonth,
  MAX_DAYS_BACK,
  monthDays,
  monthLabel,
  WEEKDAY_SHORT,
} from "../domain/attendance";
import { addDays } from "../domain/contracts";
import { EMPLOYEE_STATUS_LABELS, FORMAT_MIME, formatEmployeeNumber, isEmployeeStatus, luandaToday, MB, safeFileName, sniffFormat } from "../domain/employee";
import { type FileFormat, hrError } from "../domain/form";
import type { AttendanceRepository, AttendanceRow } from "./attendance-ports";
import type { ContractEmployee } from "./contract-ports";
import type { HrFileStore } from "./employee-ports";
import type { HrActor } from "./Registration";

const PROOF_FORMATS: FileFormat[] = ["pdf", "jpg", "png"];
const PROOF_MAX_MB = 10;
const MAX_ENTRIES = 1000;

const employeeDto = (e: ContractEmployee) => ({
  id: e.id,
  fullName: e.fullName,
  number: formatEmployeeNumber(e.number),
  status: e.status,
  statusLabel: isEmployeeStatus(e.status) ? EMPLOYEE_STATUS_LABELS[e.status] : e.status,
  jobTitle: e.jobTitle,
  department: e.department,
  typeName: e.typeName,
});

const recordDto = (r: AttendanceRow) => ({
  id: r.id,
  day: r.day,
  status: r.status,
  statusLabel: ATTENDANCE_STATUSES[r.status].label,
  code: ATTENDANCE_STATUSES[r.status].code,
  minutesLate: r.minutesLate,
  note: r.note,
  proof: r.proof ? { name: r.proof.name, mimeType: r.proof.mimeType, size: r.proof.size, uploadedAt: r.proof.uploadedAt.toISOString() } : null,
  updatedAt: r.updatedAt.toISOString(),
});

const catalog = () => ATTENDANCE_STATUS_KEYS.map((s) => ({ value: s, label: ATTENDANCE_STATUSES[s].label, code: ATTENDANCE_STATUSES[s].code }));

/**
 * Assiduidade dos funcionários, registada pelo RH: a folha do dia (marcar presenças, atrasos e
 * faltas, com comprovativo) e o mapa mensal com os totais de cada funcionário.
 * Ver: hr.attendance.view · marcar: hr.attendance.manage.
 */
export class Attendance {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  /** A folha de um dia (por omissão hoje): cada funcionário com o seu registo (ou por marcar). */
  async day(repo: AttendanceRepository, access: { manage: boolean }, input: { date?: string }) {
    const today = this.today();
    const d = checkDay(input.date ?? today, today);
    if (!d.ok) return d;
    const day = d.value;
    const [employees, records] = await Promise.all([repo.employeesFor(day, day), repo.records(day, day)]);
    const byEmployee = new Map(records.map((r) => [r.employeeId, r]));
    const t = attendanceTotals(records);
    return ok({
      date: day,
      label: dayLabel(day),
      today,
      previous: addDays(day, -1) >= addDays(today, -MAX_DAYS_BACK) ? addDays(day, -1) : null,
      next: day < today ? addDays(day, 1) : null,
      weekend: [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()),
      canManage: access.manage,
      statuses: catalog(),
      rows: employees.map((e) => {
        const r = byEmployee.get(e.id);
        return { employee: employeeDto(e), record: r ? recordDto(r) : null };
      }),
      counts: { ...t, total: employees.length, unmarked: employees.length - records.length },
    });
  }

  /** Grava a folha do dia (só as linhas enviadas; status null = volta a por marcar). */
  async saveDay(
    repo: AttendanceRepository,
    files: HrFileStore,
    actor: HrActor,
    access: { manage: boolean },
    input: { date: string; entries: { employeeId: string; status: string | null; minutesLate?: number | null; note?: string | null }[] },
  ) {
    const today = this.today();
    const d = checkDay(input.date, today);
    if (!d.ok) return d;
    if (!input.entries.length) return fail(hrError("INVALID_INPUT", "Nada para gravar."));
    if (input.entries.length > MAX_ENTRIES) return fail(hrError("INVALID_INPUT", `No máximo ${MAX_ENTRIES} linhas de cada vez.`));
    if (new Set(input.entries.map((e) => e.employeeId)).size !== input.entries.length) return fail(hrError("INVALID_INPUT", "O mesmo funcionário aparece duas vezes."));
    const employees = new Map((await repo.employeesFor(d.value, d.value)).map((e) => [e.id, e]));
    const entries: AttendanceEntry[] = [];
    for (const raw of input.entries) {
      const e = employees.get(raw.employeeId);
      if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Só se marca a assiduidade de funcionários ativos."));
      const entry = checkEntry(raw, e.fullName);
      if (!entry.ok) return entry;
      entries.push(entry.value);
    }
    const now = this.clock.now();
    const r = await repo.saveDay(d.value, entries, actor.id, now, () => this.ids.next());
    for (const key of r.orphanProofs) await files.remove(key).catch(() => undefined);
    // histórico de cada funcionário: quem marcou o quê e em que dia
    await repo.recordMany(
      entries.map((x) => ({ type: "HR_ATTENDANCE_SET", subjectId: x.employeeId, details: { day: d.value, status: x.status, minutesLate: x.minutesLate } })),
      actor.id,
      now,
    );
    const view = await this.day(repo, access, { date: d.value });
    return view.ok ? ok({ saved: r.saved, cleared: r.cleared, day: view.value }) : view;
  }

  /** O mapa do mês: funcionários × dias (letra de cada dia) e os totais de cada um. */
  async month(repo: AttendanceRepository, input: { month?: string }) {
    const today = this.today();
    const month = input.month ?? today.slice(0, 7);
    if (!isMonth(month)) return fail(hrError("INVALID_INPUT", "Mês inválido (AAAA-MM)."));
    const days = monthDays(month);
    const from = days[0].date;
    const to = days[days.length - 1].date;
    const [employees, records] = await Promise.all([repo.employeesFor(from, to), repo.records(from, to)]);
    const byEmployee = new Map<string, AttendanceRow[]>();
    for (const r of records) byEmployee.set(r.employeeId, [...(byEmployee.get(r.employeeId) ?? []), r]);
    // dias úteis já passados (até hoje) — para "por marcar"
    const workdays = days.filter((d) => !d.weekend && d.date <= today).map((d) => d.date);
    const prev = addDays(from, -1).slice(0, 7);
    const next = addDays(to, 1).slice(0, 7);
    return ok({
      month,
      label: monthLabel(month),
      today,
      previous: prev,
      next: next <= today.slice(0, 7) ? next : null,
      statuses: catalog(),
      days: days.map((d) => ({ ...d, weekdayShort: WEEKDAY_SHORT[d.weekday], future: d.date > today })),
      rows: employees.map((e) => {
        const mine = byEmployee.get(e.id) ?? [];
        const marked = new Set(mine.map((r) => r.day));
        return {
          employee: employeeDto(e),
          cells: Object.fromEntries(mine.map((r) => [r.day, { id: r.id, code: ATTENDANCE_STATUSES[r.status].code, status: r.status, minutesLate: r.minutesLate, note: r.note, hasProof: !!r.proof }])),
          totals: { ...attendanceTotals(mine), unmarked: workdays.filter((d) => !marked.has(d)).length },
        };
      }),
      totals: { ...attendanceTotals(records), workdays: workdays.length },
    });
  }

  // ================================================================ comprovativos

  async uploadProof(repo: AttendanceRepository, files: HrFileStore, actor: HrActor, recordId: string, file: { originalname: string; buffer: Buffer } | undefined) {
    const r = await repo.find(recordId);
    if (!r) return fail(hrError("ATTENDANCE_NOT_FOUND", "Registo não encontrado."));
    if (r.status === "PRESENTE") return fail(hrError("INVALID_STATE", "Uma presença não leva comprovativo."));
    if (!files.ready) return fail(hrError("STORAGE_NOT_CONFIGURED", "O envio de ficheiros ainda não está disponível neste colégio (falta configurar o armazenamento). Fale com a EduFlow."));
    if (!file?.buffer?.length) return fail(hrError("FILE_INVALID", "Escolha um ficheiro."));
    if (file.buffer.length > PROOF_MAX_MB * MB) return fail(hrError("FILE_TOO_LARGE", `O ficheiro tem mais de ${PROOF_MAX_MB} MB.`));
    const format = sniffFormat(file.buffer, file.originalname);
    if (!format || !PROOF_FORMATS.includes(format)) return fail(hrError("FILE_INVALID", "Formato não aceite. Envie PDF, JPG ou PNG."));
    const name = safeFileName(file.originalname, format);
    let stored: { key: string };
    try {
      stored = await files.save(`hr-${r.employeeId}`, { fileName: name, mimeType: FORMAT_MIME[format], content: file.buffer });
    } catch (err) {
      console.error(`[hr] não foi possível guardar o comprovativo ${r.id}: ${err instanceof Error ? err.message.slice(0, 200) : "erro"}`);
      return fail(hrError("STORAGE_UNAVAILABLE", "Não foi possível guardar o ficheiro agora (ligação ao armazenamento). Tente de novo dentro de instantes."));
    }
    const now = this.clock.now();
    const previous = await repo.setProof(recordId, { name, mimeType: FORMAT_MIME[format], size: file.buffer.length, uploadedAt: now, storageKey: stored.key }, sha256(file.buffer), now);
    if (previous) await files.remove(previous).catch(() => undefined);
    await repo.record("HR_ATTENDANCE_PROOF_UPLOADED", r.employeeId, actor.id, { recordId, day: r.day }, now);
    return ok(recordDto((await repo.find(recordId))!));
  }

  async readProof(repo: AttendanceRepository, files: HrFileStore, recordId: string) {
    const r = await repo.find(recordId);
    if (!r?.proof) return fail(hrError("FILE_NOT_FOUND", "Este registo não tem comprovativo."));
    try {
      return ok({ employeeId: r.employeeId, fileName: r.proof.name, mimeType: r.proof.mimeType, content: await files.read(r.proof.storageKey) });
    } catch (e) {
      if (e instanceof Error && e.name === "StorageNotConfiguredError") return fail(hrError("STORAGE_NOT_CONFIGURED", "Não é possível abrir este ficheiro: o armazenamento do colégio não está configurado. Fale com a EduFlow."));
      throw e;
    }
  }

  async removeProof(repo: AttendanceRepository, files: HrFileStore, actor: HrActor, recordId: string) {
    const r = await repo.find(recordId);
    if (!r?.proof) return fail(hrError("FILE_NOT_FOUND", "Este registo não tem comprovativo."));
    const now = this.clock.now();
    const previous = await repo.setProof(recordId, null, null, now);
    if (previous) await files.remove(previous).catch(() => undefined);
    await repo.record("HR_ATTENDANCE_PROOF_REMOVED", r.employeeId, actor.id, { recordId, day: r.day }, now);
    return ok({ removed: true });
  }
}
