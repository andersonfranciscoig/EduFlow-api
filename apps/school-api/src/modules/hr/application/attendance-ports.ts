import type { AttendanceEntry, AttendanceStatus } from "../domain/attendance";
import type { ContractEmployee } from "./contract-ports";

export interface AttendanceProof {
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  storageKey: string;
}

export interface AttendanceRow {
  id: string;
  employeeId: string;
  /** "AAAA-MM-DD" */
  day: string;
  status: AttendanceStatus;
  minutesLate: number | null;
  note: string | null;
  proof: AttendanceProof | null;
  updatedAt: Date;
}

/** Assiduidade (na BD do PRÓPRIO colégio). */
export interface AttendanceRepository {
  /** Funcionários ativos + quem já tiver registos entre as datas (para corrigir). */
  employeesFor(from: string, to: string): Promise<ContractEmployee[]>;
  records(from: string, to: string): Promise<AttendanceRow[]>;
  find(id: string): Promise<(AttendanceRow & { employee: ContractEmployee }) | null>;
  /** Grava a folha do dia numa transação (status null = apaga). Devolve as chaves dos comprovativos que deixaram de servir. */
  saveDay(day: string, entries: AttendanceEntry[], actorId: string | null, now: Date, newId: () => string): Promise<{ saved: number; cleared: number; orphanProofs: string[] }>;
  /** Troca (ou retira) o comprovativo; devolve a chave do anterior. */
  setProof(id: string, proof: AttendanceProof | null, sha256: string | null, now: Date): Promise<string | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
  recordMany(events: { type: string; subjectId: string; details: Record<string, unknown> }[], actorId: string | null, now: Date): Promise<void>;
}
