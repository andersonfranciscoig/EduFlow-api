import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { EmailAddress, FullName, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { ACCOUNT_KINDS, ageOn, canAccessStudent, familyError, isAdult, luandaToday, STUDENT_STATUS_LABELS } from "../domain/family";
import type { FamilyAccountRow, FamilyMailer, FamilyRepository, School } from "./ports";

const NOTIFICATIONS_SHOWN = 60;

/**
 * A área da família: quem é a conta (encarregado, aluno, ou os dois) e os alunos que pode ver.
 * O acesso decide-se aqui, com a idade calculada hoje em Luanda (nunca vem do navegador):
 *   o próprio aluno (titular) vê-se sempre; o encarregado que gere só vê educandos menores.
 * Fase H: as notificações e a passagem da conta ao educando que fez 18 anos.
 */
export class FamilyHome {
  constructor(
    private readonly clock: Clock,
    private readonly countryCode: string,
    private readonly mailer: FamilyMailer,
    private readonly ids: IdGenerator,
  ) {}

  async me(repo: FamilyRepository, account: FamilyAccountRow) {
    const today = luandaToday(this.clock.now());
    const [students, guardian, unread] = await Promise.all([repo.linkedStudents(account.id), repo.guardianOf(account.id), repo.unreadCount(account.id)]);
    const visible = students.filter((s) => canAccessStudent(s, s.birthDate, today));
    const former = students.filter((s) => !s.self && s.managingGuardian && isAdult(s.birthDate, today));
    const handovers = await repo.handovers(former.map((s) => s.id));
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
      // educandos que já fizeram 18 anos: a conta deixa de os gerir; o encarregado convida-os a gerir a própria conta
      formerDependents: former.map((s) => {
        const h = handovers.find((x) => x.studentId === s.id);
        return {
          id: s.id,
          fullName: s.fullName,
          ownAccount: h?.studentHasAccount ?? false,
          handover: h ? { email: h.email, status: h.status, sentAt: h.createdAt.toISOString(), doneAt: h.completedAt?.toISOString() ?? null } : null,
        };
      }),
      unreadNotifications: unread,
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

  // ---------------------------------------------------------------- notificações

  async notifications(repo: FamilyRepository, account: FamilyAccountRow) {
    const [items, unread] = await Promise.all([repo.notifications(account.id, NOTIFICATIONS_SHOWN), repo.unreadCount(account.id)]);
    return {
      unread,
      items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.readAt, createdAt: n.createdAt.toISOString() })),
    };
  }

  /** Marcar como lidas: as indicadas, ou todas. */
  async markRead(repo: FamilyRepository, account: FamilyAccountRow, ids: string[] | undefined) {
    const marked = await repo.markRead(account.id, ids?.length ? ids : null, this.clock.now());
    return { marked, unread: await repo.unreadCount(account.id) };
  }

  // ---------------------------------------------------------------- passar a conta ao aluno (18 anos)

  /**
   * O encarregado que geria o educando, agora maior, convida-o a gerir a própria conta: o aluno
   * recebe um email; quando cria (ou entra com) a conta de aluno maior com esse email e a mesma
   * data de nascimento, o registo passa a ser dele (ver claimHandovers).
   */
  async inviteHandover(repo: FamilyRepository, school: School, account: FamilyAccountRow, studentId: string, rawEmail: string) {
    const today = luandaToday(this.clock.now());
    const s = await repo.handoverTarget(account.id, studentId);
    if (!s || !s.managing) return fail(familyError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    if (!isAdult(s.birthDate, today)) return fail(familyError("INVALID_INPUT", "O aluno ainda não tem 18 anos: continua a ser gerido pelo encarregado."));
    if (s.hasAccount) return fail(familyError("INVALID_INPUT", "O aluno já gere a própria conta."));
    const email = EmailAddress.create(rawEmail);
    if (!email.ok) return fail(familyError("INVALID_INPUT", email.error.message));
    if (email.value.value === account.email.toLowerCase()) return fail(familyError("INVALID_INPUT", "Indique o email do aluno (não o seu): é ele quem vai entrar com essa conta."));
    const now = this.clock.now();
    await repo.createHandover({ id: this.ids.next(), studentId: s.id, email: email.value.value, createdById: account.id, now });
    await repo.record("STUDENT_HANDOVER_INVITED", s.id, account.id, { email: email.value.value }, now);
    try {
      await this.mailer.handoverInvite({ to: { email: email.value.value, name: s.fullName }, school, guardianName: account.fullName });
    } catch {
      /* o convite fica guardado; pode reenviar */
    }
    await repo.notify({ accountId: account.id, kind: "HANDOVER_INVITED", title: `Convite enviado a ${s.fullName}`, body: `Para ${email.value.value}. Quando criar a conta de aluno maior, o registo passa a ser dele.`, link: "/familia", studentId: s.id, now });
    return ok({ email: email.value.value, status: "PENDING" as const });
  }
}
