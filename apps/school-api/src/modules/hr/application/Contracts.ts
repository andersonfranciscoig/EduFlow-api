import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import {
  addDays,
  CONTRACT_KIND_KEYS,
  CONTRACT_KINDS,
  CONTRACT_REGIMES,
  CONTRACT_STATUS_LABELS,
  CONTRACTABLE,
  type ContractStatus,
  checkContract,
  checkSalary,
  checkTermination,
  contractStatus,
  EXPIRING_DAYS,
  effectiveEnd,
  formatContractNumber,
} from "../domain/contracts";
import { EMPLOYEE_STATUS_LABELS, FORMAT_MIME, formatEmployeeNumber, isEmployeeStatus, luandaToday, MB, safeFileName, sniffFormat } from "../domain/employee";
import { type FileFormat, hrError } from "../domain/form";
import type { ContractEmployee, ContractRepository, ContractRow } from "./contract-ports";
import type { HrFileStore } from "./employee-ports";
import type { HrActor } from "./Registration";

/** O que o utilizador pode fazer nos contratos (o controller lê das permissões). */
export interface ContractAccess {
  manage: boolean;
  /** ver e definir o salário base */
  salary: boolean;
}

export interface ContractInput {
  kind: string;
  regime: string;
  weeklyHours: number;
  jobTitle: string;
  department?: string | null;
  startsOn: string;
  endsOn?: string | null;
  trialEndsOn?: string | null;
  notes?: string | null;
  /** undefined = não mexer; só com a permissão do salário */
  baseSalary?: number | null;
}

export type ContractView = "vigentes" | "a-terminar" | "terminados" | "sem-contrato";
export const CONTRACT_VIEWS: ContractView[] = ["vigentes", "a-terminar", "terminados", "sem-contrato"];

const FILE_FORMATS: FileFormat[] = ["pdf", "jpg", "png"];
const FILE_MAX_MB = 10;

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

/**
 * Contratos dos funcionários: histórico por funcionário, criar, alterar, renovar, rescindir,
 * cópia assinada (cifrada) e a lista do colégio (vigentes, a terminar, terminados, sem contrato).
 * Ver: hr.contracts.view · alterar: hr.contracts.manage · salário: hr.contracts.salary.
 */
export class Contracts {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  private dto(c: ContractRow, today: string, access: ContractAccess) {
    const s = contractStatus(c, today);
    return {
      id: c.id,
      number: c.number,
      numberLabel: formatContractNumber(c.number),
      employeeId: c.employeeId,
      kind: c.kind,
      kindLabel: CONTRACT_KINDS[c.kind].label,
      kindShort: CONTRACT_KINDS[c.kind].short,
      regime: c.regime,
      regimeLabel: CONTRACT_REGIMES[c.regime],
      weeklyHours: c.weeklyHours,
      jobTitle: c.jobTitle,
      department: c.department,
      startsOn: c.startsOn,
      endsOn: c.endsOn,
      effectiveEnd: effectiveEnd(c),
      trialEndsOn: c.trialEndsOn,
      inTrial: !!c.trialEndsOn && s.status === "VIGENTE" && today <= c.trialEndsOn,
      notes: c.notes,
      previousId: c.previousId,
      terminatedOn: c.terminatedOn,
      terminationReason: c.terminationReason,
      status: s.status,
      statusLabel: CONTRACT_STATUS_LABELS[s.status],
      daysLeft: s.daysLeft,
      expiring: s.expiring,
      // o salário só para quem tem a permissão (para os outros nem o "por definir" se revela)
      baseSalary: access.salary ? c.baseSalary : null,
      salaryHidden: !access.salary,
      file: c.file ? { name: c.file.name, mimeType: c.file.mimeType, size: c.file.size, uploadedAt: c.file.uploadedAt.toISOString() } : null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  /** Os tipos e regimes (para o formulário). */
  catalog() {
    return {
      kinds: CONTRACT_KIND_KEYS.map((k) => ({ value: k, label: CONTRACT_KINDS[k].label, short: CONTRACT_KINDS[k].short, end: CONTRACT_KINDS[k].end })),
      regimes: (Object.keys(CONTRACT_REGIMES) as (keyof typeof CONTRACT_REGIMES)[]).map((r) => ({ value: r, label: CONTRACT_REGIMES[r] })),
      expiringDays: EXPIRING_DAYS,
    };
  }

  /** Os contratos de um funcionário (mais recente primeiro) e o que se pode fazer. */
  async employeeContracts(repo: ContractRepository, access: ContractAccess, employeeId: string) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    const today = this.today();
    const contracts = (await repo.contractsOf(employeeId)).map((c) => this.dto(c, today, access)).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
    const current = contracts.find((c) => c.status === "VIGENTE") ?? null;
    const last = contracts[0] ?? null;
    return ok({
      employee: employeeDto(e),
      canManage: access.manage && (CONTRACTABLE as readonly string[]).includes(e.status),
      canSeeSalary: access.salary,
      contractable: (CONTRACTABLE as readonly string[]).includes(e.status),
      current,
      contracts,
      // renovar: o novo começa no dia a seguir ao fim do último
      suggestedStart: last?.effectiveEnd ? addDays(last.effectiveEnd, 1) : today,
      catalog: this.catalog(),
    });
  }

  private salaryOf(access: ContractAccess, input: ContractInput) {
    if (input.baseSalary === undefined) return ok(undefined);
    if (!access.salary) return fail(hrError("FORBIDDEN", "Não tem permissão para definir salários."));
    return checkSalary(input.baseSalary);
  }

  private overlap(withNumber: number) {
    return fail(hrError("CONTRACT_OVERLAP", `As datas sobrepõem-se ao contrato ${formatContractNumber(withNumber)} deste funcionário. Rescinda-o ou ajuste as datas.`));
  }

  async create(repo: ContractRepository, actor: HrActor, access: ContractAccess, employeeId: string, input: ContractInput & { previousId?: string | null }) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    if (!(CONTRACTABLE as readonly string[]).includes(e.status)) return fail(hrError("INVALID_STATE", "Só funcionários aprovados, ativos ou suspensos podem ter contratos."));
    const data = checkContract(input);
    if (!data.ok) return data;
    const salary = this.salaryOf(access, input);
    if (!salary.ok) return salary;
    if (input.previousId) {
      const prev = await repo.find(input.previousId);
      if (!prev || prev.employeeId !== employeeId) return fail(hrError("CONTRACT_NOT_FOUND", "O contrato a renovar não é deste funcionário."));
    }
    const now = this.clock.now();
    const r = await repo.create({ id: this.ids.next(), employeeId, data: data.value, baseSalary: salary.value ?? null, previousId: input.previousId ?? null, actorId: actor.id, now });
    if (!r.ok) return this.overlap(r.with);
    await repo.record("HR_CONTRACT_CREATED", employeeId, actor.id, { contractId: r.value.id, number: r.value.number, renewal: !!input.previousId, salarySet: salary.value != null }, now);
    const c = (await repo.find(r.value.id))!;
    return ok(this.dto(c, this.today(), access));
  }

  /** Corrigir um contrato que ainda não acabou nem foi rescindido. */
  async update(repo: ContractRepository, actor: HrActor, access: ContractAccess, contractId: string, input: ContractInput) {
    const c = await repo.find(contractId);
    if (!c) return fail(hrError("CONTRACT_NOT_FOUND", "Contrato não encontrado."));
    const status = contractStatus(c, this.today()).status;
    if (c.terminatedOn) return fail(hrError("INVALID_STATE", "Um contrato rescindido já não se altera."));
    if (status === "CADUCADO") return fail(hrError("INVALID_STATE", "Este contrato já acabou: para continuar, renove-o."));
    const data = checkContract(input);
    if (!data.ok) return data;
    const salary = this.salaryOf(access, input);
    if (!salary.ok) return salary;
    const now = this.clock.now();
    const r = await repo.update(contractId, { data: data.value, baseSalary: salary.value, now });
    if (!r.ok) return this.overlap(r.with);
    const salaryChanged = salary.value !== undefined && salary.value !== c.baseSalary;
    // o valor do salário nunca vai para o histórico: só que mudou
    await repo.record("HR_CONTRACT_UPDATED", c.employeeId, actor.id, { contractId, number: c.number, salaryChanged }, now);
    return ok(this.dto((await repo.find(contractId))!, this.today(), access));
  }

  async terminate(repo: ContractRepository, actor: HrActor, access: ContractAccess, contractId: string, input: { terminatedOn: string; reason: string }) {
    const c = await repo.find(contractId);
    if (!c) return fail(hrError("CONTRACT_NOT_FOUND", "Contrato não encontrado."));
    if (contractStatus(c, this.today()).status === "CADUCADO") return fail(hrError("INVALID_STATE", "Este contrato já acabou."));
    const t = checkTermination(c, input);
    if (!t.ok) return t;
    const now = this.clock.now();
    await repo.terminate(contractId, { ...t.value, now });
    await repo.record("HR_CONTRACT_TERMINATED", c.employeeId, actor.id, { contractId, number: c.number, terminatedOn: t.value.terminatedOn }, now);
    return ok(this.dto((await repo.find(contractId))!, this.today(), access));
  }

  /** Apagar só um contrato que ainda não começou (criado por engano); os outros rescindem-se. */
  async remove(repo: ContractRepository, files: HrFileStore, actor: HrActor, contractId: string) {
    const c = await repo.find(contractId);
    if (!c) return fail(hrError("CONTRACT_NOT_FOUND", "Contrato não encontrado."));
    if (contractStatus(c, this.today()).status !== "FUTURO") return fail(hrError("INVALID_STATE", "Só se apaga um contrato que ainda não começou. Este rescinde-se."));
    await repo.remove(contractId);
    if (c.file) await files.remove(c.file.storageKey).catch(() => undefined);
    await repo.record("HR_CONTRACT_DELETED", c.employeeId, actor.id, { number: c.number }, this.clock.now());
    return ok({ removed: true });
  }

  // ================================================================ cópia assinada

  async uploadFile(repo: ContractRepository, files: HrFileStore, actor: HrActor, access: ContractAccess, contractId: string, file: { originalname: string; buffer: Buffer } | undefined) {
    const c = await repo.find(contractId);
    if (!c) return fail(hrError("CONTRACT_NOT_FOUND", "Contrato não encontrado."));
    if (!files.ready) return fail(hrError("STORAGE_NOT_CONFIGURED", "O envio de ficheiros ainda não está disponível neste colégio (falta configurar o armazenamento). Fale com a EduFlow."));
    if (!file?.buffer?.length) return fail(hrError("FILE_INVALID", "Escolha um ficheiro."));
    if (file.buffer.length > FILE_MAX_MB * MB) return fail(hrError("FILE_TOO_LARGE", `O ficheiro tem mais de ${FILE_MAX_MB} MB.`));
    const format = sniffFormat(file.buffer, file.originalname);
    if (!format || !FILE_FORMATS.includes(format)) return fail(hrError("FILE_INVALID", "Formato não aceite. Envie PDF, JPG ou PNG."));
    const name = safeFileName(file.originalname, format);
    let stored: { key: string };
    try {
      stored = await files.save(`hr-${c.employeeId}`, { fileName: name, mimeType: FORMAT_MIME[format], content: file.buffer });
    } catch (err) {
      console.error(`[hr] não foi possível guardar a cópia do contrato ${c.id}: ${err instanceof Error ? err.message.slice(0, 200) : "erro"}`);
      return fail(hrError("STORAGE_UNAVAILABLE", "Não foi possível guardar o ficheiro agora (ligação ao armazenamento). Tente de novo dentro de instantes."));
    }
    const now = this.clock.now();
    const previous = await repo.setFile(contractId, { name, mimeType: FORMAT_MIME[format], size: file.buffer.length, uploadedAt: now, storageKey: stored.key }, sha256(file.buffer), now);
    if (previous) await files.remove(previous).catch(() => undefined);
    await repo.record("HR_CONTRACT_FILE_UPLOADED", c.employeeId, actor.id, { contractId, number: c.number }, now);
    return ok(this.dto((await repo.find(contractId))!, this.today(), access));
  }

  async readFile(repo: ContractRepository, files: HrFileStore, contractId: string) {
    const c = await repo.find(contractId);
    if (!c?.file) return fail(hrError("FILE_NOT_FOUND", "Este contrato não tem cópia assinada."));
    try {
      return ok({ employeeId: c.employeeId, fileName: c.file.name, mimeType: c.file.mimeType, content: await files.read(c.file.storageKey) });
    } catch (e) {
      if (e instanceof Error && e.name === "StorageNotConfiguredError") return fail(hrError("STORAGE_NOT_CONFIGURED", "Não é possível abrir este ficheiro: o armazenamento do colégio não está configurado. Fale com a EduFlow."));
      throw e;
    }
  }

  async removeFile(repo: ContractRepository, files: HrFileStore, actor: HrActor, contractId: string) {
    const c = await repo.find(contractId);
    if (!c?.file) return fail(hrError("FILE_NOT_FOUND", "Este contrato não tem cópia assinada."));
    const now = this.clock.now();
    const previous = await repo.setFile(contractId, null, null, now);
    if (previous) await files.remove(previous).catch(() => undefined);
    await repo.record("HR_CONTRACT_FILE_REMOVED", c.employeeId, actor.id, { contractId, number: c.number }, now);
    return ok({ removed: true });
  }

  // ================================================================ lista do colégio

  /** Contratos do colégio por vista, com as contagens de cada vista (e a massa salarial, com permissão). */
  async list(repo: ContractRepository, access: ContractAccess, input: { view?: string; q?: string }) {
    const view: ContractView = CONTRACT_VIEWS.includes(input.view as ContractView) ? (input.view as ContractView) : "vigentes";
    const today = this.today();
    const [all, employees] = await Promise.all([repo.all(), repo.contractableEmployees()]);
    const rows = all.map((c) => ({ ...this.dto(c, today, access), employee: employeeDto(c.employee) }));
    const live = (s: ContractStatus) => s === "VIGENTE" || s === "FUTURO";
    const covered = new Set(rows.filter((r) => live(r.status)).map((r) => r.employeeId));
    const without = employees.filter((e) => !covered.has(e.id)).map(employeeDto);
    const q = input.q?.trim().toLowerCase();
    const match = (name: string, extra = "") => !q || `${name} ${extra}`.toLowerCase().includes(q);

    const byView: Record<Exclude<ContractView, "sem-contrato">, typeof rows> = {
      vigentes: rows.filter((r) => live(r.status)).sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName)),
      "a-terminar": rows.filter((r) => r.status === "VIGENTE" && r.expiring).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0)),
      terminados: rows.filter((r) => !live(r.status)).sort((a, b) => (b.effectiveEnd ?? "").localeCompare(a.effectiveEnd ?? "")),
    };
    const vigentes = rows.filter((r) => r.status === "VIGENTE");
    return ok({
      view,
      canManage: access.manage,
      canSeeSalary: access.salary,
      counts: { vigentes: byView.vigentes.length, "a-terminar": byView["a-terminar"].length, terminados: byView.terminados.length, "sem-contrato": without.length },
      contracts: view === "sem-contrato" ? [] : byView[view].filter((r) => match(r.employee.fullName, `${r.numberLabel} ${r.jobTitle}`)),
      employeesWithout: view === "sem-contrato" ? without.filter((e) => match(e.fullName, e.jobTitle ?? "")).sort((a, b) => a.fullName.localeCompare(b.fullName)) : [],
      // massa salarial dos contratos vigentes (só com a permissão do salário)
      payroll: access.salary
        ? { total: vigentes.reduce((n, r) => n + (r.baseSalary ?? 0), 0), contracts: vigentes.length, withoutSalary: vigentes.filter((r) => r.baseSalary === null).length }
        : null,
      expiringDays: EXPIRING_DAYS,
    });
  }
}
