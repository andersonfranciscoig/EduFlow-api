import type { OtpStats } from "../../../../../../libs/kernel/src/domain/email-otp";
import type { CodePurpose, FamilyStatus, StudentStatus } from "../domain/family";

export interface FamilyAccountRow {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  passwordHash: string;
  status: FamilyStatus;
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface FamilyCodeRow {
  id: string;
  accountId: string;
  purpose: CodePurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Um aluno visto da conta: e a relação que os liga. */
export interface LinkedStudent {
  id: string;
  number: number | null;
  fullName: string;
  /** "AAAA-MM-DD" */
  birthDate: string;
  gender: string | null;
  status: StudentStatus;
  self: boolean;
  managingGuardian: boolean;
  relationship: string | null;
}

/** Contas de família, códigos e sessões (na BD do PRÓPRIO colégio). */
export interface FamilyRepository {
  byEmail(email: string): Promise<FamilyAccountRow | null>;
  byId(id: string): Promise<FamilyAccountRow | null>;
  create(input: { id: string; email: string; fullName: string; phone: string | null; passwordHash: string; now: Date }): Promise<void>;
  update(id: string, set: Partial<Pick<FamilyAccountRow, "fullName" | "phone" | "passwordHash" | "status" | "failedLogins" | "lockedUntil" | "lastLoginAt">> & { activatedAt?: Date; now: Date }): Promise<void>;
  saveCode(code: FamilyCodeRow): Promise<void>;
  latestCode(accountId: string, purpose: CodePurpose): Promise<FamilyCodeRow | null>;
  codeStats(accountId: string, purpose: CodePurpose, since: Date): Promise<OtpStats>;
  openSession(input: { id: string; accountId: string; ip: string | null; userAgent: string | null; now: Date; expiresAt: Date }): Promise<void>;
  /** A sessão ativa (não revogada, não expirada) — renova o "visto" e a validade. */
  touchSession(sessionId: string, accountId: string, now: Date, expiresAt: Date): Promise<boolean>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  revokeAll(accountId: string, now: Date): Promise<void>;
  /** Alunos ligados à conta: o próprio (titular) e os educandos do encarregado desta conta. */
  linkedStudents(accountId: string): Promise<LinkedStudent[]>;
  guardianOf(accountId: string): Promise<{ id: string; fullName: string } | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

export interface FamilyMailer {
  sendCode(input: { to: { email: string; name: string }; school: { name: string; slug: string }; purpose: CodePurpose; code: string; validMinutes: number }): Promise<void>;
  /** Alguém tentou criar conta com um email que já tem conta. */
  alreadyRegistered(input: { to: { email: string; name: string }; school: { name: string; slug: string } }): Promise<void>;
}

export interface FamilyTokens {
  issueAccess(input: { accountId: string; sessionId: string; schoolId: string }): Promise<{ accessToken: string; expiresIn: number }>;
  verifyAccess(token: string): Promise<{ accountId: string; sessionId: string; schoolId: string } | null>;
  issueChallenge(input: { accountId: string; schoolId: string }): Promise<string>;
  verifyChallenge(token: string, schoolId: string): Promise<{ accountId: string } | null>;
}

export interface School {
  id: string;
  name: string;
  slug: string;
}
