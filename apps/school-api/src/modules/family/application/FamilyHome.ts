import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { FullName, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { ACCOUNT_KINDS, ageOn, canAccessStudent, familyError, isAdult, luandaToday, STUDENT_STATUS_LABELS } from "../domain/family";
import type { FamilyAccountRow, FamilyRepository } from "./ports";

/**
 * A área da família: quem é a conta (encarregado, aluno, ou os dois) e os alunos que pode ver.
 * O acesso decide-se aqui, com a idade calculada hoje em Luanda (nunca vem do navegador):
 *   o próprio aluno (titular) vê-se sempre; o encarregado que gere só vê educandos menores.
 */
export class FamilyHome {
  constructor(
    private readonly clock: Clock,
    private readonly countryCode: string,
  ) {}

  async me(repo: FamilyRepository, account: FamilyAccountRow) {
    const today = luandaToday(this.clock.now());
    const [students, guardian] = await Promise.all([repo.linkedStudents(account.id), repo.guardianOf(account.id)]);
    const visible = students.filter((s) => canAccessStudent(s, s.birthDate, today));
    const dto = (s: (typeof students)[number]) => ({
      id: s.id,
      number: s.number,
      fullName: s.fullName,
      birthDate: s.birthDate,
      age: ageOn(s.birthDate, today),
      adult: isAdult(s.birthDate, today),
      status: s.status,
      statusLabel: STUDENT_STATUS_LABELS[s.status],
      relationship: s.self ? null : s.relationship,
    });
    return {
      account: {
        id: account.id,
        fullName: account.fullName,
        email: account.email,
        phone: account.phone,
        kind: account.kind,
        kindLabel: ACCOUNT_KINDS[account.kind].label,
        birthDate: account.birthDate,
        memberSince: account.createdAt.toISOString(),
      },
      // a conta é aluno ela própria?
      self: visible.find((s) => s.self) ? dto(visible.find((s) => s.self)!) : null,
      guardian: guardian ? { id: guardian.id, fullName: guardian.fullName } : null,
      // educandos menores que esta conta gere
      dependents: visible.filter((s) => !s.self).map(dto),
      // educandos que já fizeram 18 anos: a conta deixa de os gerir (o aluno passa a titular)
      formerDependents: students.filter((s) => !s.self && s.managingGuardian && isAdult(s.birthDate, today)).map((s) => ({ id: s.id, fullName: s.fullName })),
    };
  }

  async updateProfile(repo: FamilyRepository, account: FamilyAccountRow, input: { fullName: string; phone?: string | null }) {
    const name = FullName.create(input.fullName);
    if (!name.ok) return fail(familyError("INVALID_INPUT", name.error.message));
    let phone: string | null = null;
    if (input.phone?.trim()) {
      const p = PhoneNumber.create(input.phone, this.countryCode);
      if (!p.ok) return fail(familyError("INVALID_INPUT", p.error.message));
      phone = p.value.value;
    }
    const now = this.clock.now();
    await repo.update(account.id, { fullName: name.value.value, phone, now });
    await repo.record("FAMILY_PROFILE_UPDATED", account.id, account.id, {}, now);
    return ok({ fullName: name.value.value, phone });
  }
}
