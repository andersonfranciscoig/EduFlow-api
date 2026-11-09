import type { School, SchoolActivityType, SchoolStatus } from "./School";

export interface SchoolActivityEntry {
  id: string;
  type: SchoolActivityType;
  actor: { id: string; fullName: string } | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface SchoolRepository {
  findById(id: string): Promise<School | null>;
  findByOwnerEmail(email: string): Promise<School | null>;
  findByReference(reference: string): Promise<School | null>;
  ownerEmailExists(email: string): Promise<boolean>;
  nifExists(nif: string): Promise<boolean>;
  referenceExists(reference: string): Promise<boolean>;
  slugExists(slug: string): Promise<boolean>;
  list(filter?: { status?: SchoolStatus }): Promise<School[]>;
  countByStatus(): Promise<Record<SchoolStatus, number>>;
  activity(schoolId: string): Promise<SchoolActivityEntry[]>;
  /**
   * Grava o agregado (colégio + encomendas) e os eventos, numa transação.
   * Se o colégio foi ativado, regista também o pedido de criação da sua base
   * de dados (outbox), para o provisioner processar.
   */
  save(school: School): Promise<void>;
}
