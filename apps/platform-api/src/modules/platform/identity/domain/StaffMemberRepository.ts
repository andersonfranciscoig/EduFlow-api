import type { StaffRole, StaffStatus } from "./access-control";
import type { StaffMember } from "./StaffMember";
import type { LoginIdentifier } from "./value-objects/LoginIdentifier";

export interface StaffListFilter {
  status?: StaffStatus;
  role?: StaffRole;
}

/** Contrato de persistência do agregado — implementado na infraestrutura. */
export interface StaffMemberRepository {
  findById(id: string): Promise<StaffMember | null>;
  findByIdentifier(identifier: LoginIdentifier): Promise<StaffMember | null>;
  list(filter?: StaffListFilter): Promise<StaffMember[]>;
  count(): Promise<number>;
  countActiveAdmins(): Promise<number>;
  /**
   * Insere ou atualiza o agregado E persiste os eventos pendentes
   * (histórico de atividade) na mesma transação.
   */
  save(member: StaffMember): Promise<void>;
}
