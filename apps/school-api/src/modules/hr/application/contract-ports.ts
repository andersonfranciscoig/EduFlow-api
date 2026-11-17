import type { ContractData } from "../domain/contracts";

/** O funcionário, como aparece nos contratos. */
export interface ContractEmployee {
  id: string;
  fullName: string;
  number: number | null;
  status: string;
  jobTitle: string | null;
  department: string | null;
  typeName: string | null;
}

export interface ContractFile {
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  storageKey: string;
}

export interface ContractRow extends ContractData {
  id: string;
  number: number;
  employeeId: string;
  /** kwanzas; null = por definir */
  baseSalary: number | null;
  previousId: string | null;
  terminatedOn: string | null;
  terminationReason: string | null;
  file: ContractFile | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ContractWrite = { ok: true; value: { id: string; number: number } } | { ok: false; reason: "overlap"; with: number };

/** Contratos (na BD do PRÓPRIO colégio). */
export interface ContractRepository {
  employee(id: string): Promise<ContractEmployee | null>;
  /** Funcionários que podem ter contrato (aprovados, ativos e suspensos). */
  contractableEmployees(): Promise<ContractEmployee[]>;
  contractsOf(employeeId: string): Promise<ContractRow[]>;
  find(id: string): Promise<(ContractRow & { employee: ContractEmployee }) | null>;
  all(): Promise<(ContractRow & { employee: ContractEmployee })[]>;
  /** Cria (n.º seguinte) sem sobrepor outro contrato do funcionário — confirmado com o funcionário bloqueado. */
  create(input: { id: string; employeeId: string; data: ContractData; baseSalary: number | null; previousId: string | null; actorId: string | null; now: Date }): Promise<ContractWrite>;
  /** Altera (o salário só quando vem definido) sem sobrepor outro contrato. */
  update(id: string, input: { data: ContractData; baseSalary?: number | null; now: Date }): Promise<ContractWrite>;
  terminate(id: string, input: { terminatedOn: string; reason: string; now: Date }): Promise<void>;
  remove(id: string): Promise<void>;
  /** Troca (ou retira, com null) a cópia assinada; devolve a chave da anterior para a apagar. */
  setFile(id: string, file: ContractFile | null, sha256: string | null, now: Date): Promise<string | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
