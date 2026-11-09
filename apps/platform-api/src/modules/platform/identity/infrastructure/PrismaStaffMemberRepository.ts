import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, StaffMember as StaffMemberRow } from ".prisma/platform-client";
import { isPermission } from "../domain/access-control";
import { StaffMember } from "../domain/StaffMember";
import type { StaffListFilter, StaffMemberRepository } from "../domain/StaffMemberRepository";
import { EmailAddress } from "../domain/value-objects/EmailAddress";
import { FullName } from "../domain/value-objects/FullName";
import type { LoginIdentifier } from "../domain/value-objects/LoginIdentifier";
import { PhoneNumber } from "../domain/value-objects/PhoneNumber";

/** Mapper persistência ⇄ domínio. Os dados na BD já foram validados ao gravar. */
function toDomain(row: StaffMemberRow): StaffMember {
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false }) => {
    if (!r.ok) throw new Error(`Registo inválido em staff_members (${row.id})`);
    return r.value;
  };

  return StaffMember.restore({
    id: row.id,
    fullName: unwrap(FullName.create(row.fullName)),
    email: row.email ? unwrap(EmailAddress.create(row.email)) : null,
    // Telefones já estão em E.164, o indicativo por omissão não se aplica.
    phone: row.phone ? unwrap(PhoneNumber.create(row.phone, "")) : null,
    passwordHash: row.passwordHash,
    role: row.role,
    status: row.status,
    // ignora permissões que entretanto deixaram de existir no catálogo
    extraPermissions: row.extraPermissions.filter(isPermission),
    failedLoginAttempts: row.failedLoginAttempts,
    lockedUntil: row.lockedUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    mfa: {
      secretCiphertext: row.mfaSecretCiphertext,
      pendingSecretCiphertext: row.mfaPendingSecretCiphertext,
      enabledAt: row.mfaEnabledAt,
      lastUsedStep: row.mfaLastUsedStep,
      recoveryCodeHashes: row.mfaRecoveryCodeHashes,
    },
  });
}

export class PrismaStaffMemberRepository implements StaffMemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string) {
    const row = await this.prisma.staffMember.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByIdentifier(identifier: LoginIdentifier) {
    const row = await this.prisma.staffMember.findUnique({
      where: identifier.kind === "email" ? { email: identifier.value } : { phone: identifier.value },
    });
    return row ? toDomain(row) : null;
  }

  async list(filter: StaffListFilter = {}) {
    const rows = await this.prisma.staffMember.findMany({
      where: { status: filter.status, role: filter.role },
      orderBy: [{ fullName: "asc" }],
    });
    return rows.map(toDomain);
  }

  count() {
    return this.prisma.staffMember.count();
  }

  countActiveAdmins() {
    return this.prisma.staffMember.count({ where: { role: "ADMIN", status: "ACTIVE" } });
  }

  async save(member: StaffMember) {
    const data = {
      fullName: member.fullName.value,
      email: member.email?.value ?? null,
      phone: member.phone?.value ?? null,
      passwordHash: member.passwordHash,
      role: member.role,
      status: member.status,
      extraPermissions: member.extraPermissions,
      failedLoginAttempts: member.failedLoginAttempts,
      lockedUntil: member.lockedUntil,
      lastLoginAt: member.lastLoginAt,
      mfaSecretCiphertext: member.mfa.secretCiphertext,
      mfaPendingSecretCiphertext: member.mfa.pendingSecretCiphertext,
      mfaEnabledAt: member.mfa.enabledAt,
      mfaLastUsedStep: member.mfa.lastUsedStep,
      mfaRecoveryCodeHashes: [...member.mfa.recoveryCodeHashes],
    };
    const events = member.pullEvents();

    // Agregado + eventos na mesma transação: o histórico nunca fica dessincronizado.
    await this.prisma.$transaction([
      this.prisma.staffMember.upsert({
        where: { id: member.id },
        create: { id: member.id, createdAt: member.createdAt, ...data },
        update: data,
      }),
      ...(events.length > 0
        ? [
            this.prisma.staffActivity.createMany({
              data: events.map((e) => ({
                id: randomUUID(),
                type: e.type,
                subjectId: e.subjectId,
                actorId: e.actorId,
                details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined,
                occurredAt: e.occurredAt,
              })),
            }),
          ]
        : []),
    ]);
  }
}
