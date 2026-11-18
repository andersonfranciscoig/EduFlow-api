import type { DocumentTypeInput, Periods } from "../domain/settings";

export interface YearRow {
  id: string;
  name: string;
  /** "AAAA-MM-DD" */
  startsOn: string;
  endsOn: string;
  status: "PLANNED" | "ACTIVE" | "CLOSED";
  periods: Periods;
  periodsUpdatedAt: Date | null;
}

export interface DocumentTypeRow extends DocumentTypeInput {
  id: string;
  position: number;
  active: boolean;
  updatedAt: Date;
}

/** Configuração das inscrições (na BD do PRÓPRIO colégio). */
export interface AdmissionSettingsRepository {
  years(): Promise<YearRow[]>;
  year(id: string): Promise<YearRow | null>;
  savePeriods(yearId: string, periods: Periods, actorId: string | null, now: Date): Promise<void>;
  documents(): Promise<DocumentTypeRow[]>;
  createDocument(input: DocumentTypeInput & { id: string; now: Date }): Promise<void>;
  /** false = não existe */
  updateDocument(id: string, input: DocumentTypeInput, now: Date): Promise<boolean>;
  setDocumentActive(id: string, active: boolean, now: Date): Promise<boolean>;
  deleteDocument(id: string): Promise<boolean>;
  reorderDocuments(ids: string[]): Promise<void>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
