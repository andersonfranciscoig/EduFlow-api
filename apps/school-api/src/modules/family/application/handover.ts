import type { FamilyAccountRow, FamilyRepository } from "./ports";

/**
 * O aluno que fez 18 anos entra (ou ativa) a conta de aluno maior com o email do convite do
 * encarregado: o registo passa a ser dele. Só com uma conta STUDENT e a MESMA data de nascimento
 * do registo (o email sozinho não chega), e só se o aluno ainda não tiver dono.
 * Avisa os dois (o encarregado e o aluno). Devolve quantos registos passaram.
 */
export async function claimHandovers(repo: FamilyRepository, account: FamilyAccountRow, now: Date) {
  if (account.kind !== "STUDENT" || !account.birthDate) return 0;
  const pending = await repo.pendingHandovers(account.email);
  let done = 0;
  for (const h of pending) {
    if (h.studentHasAccount || h.studentBirthDate !== account.birthDate) continue;
    if (!(await repo.completeHandover({ id: h.id, studentId: h.studentId, accountId: account.id, now }))) continue;
    done++;
    await repo.record("STUDENT_HANDOVER_DONE", h.studentId, account.id, { handoverId: h.id }, now);
    await repo.notify({
      accountId: account.id,
      kind: "HANDOVER_WELCOME",
      title: "Bem-vindo à sua conta",
      body: "O seu registo de aluno passou a ser seu: inscrições, renovações e o seu percurso ficam aqui.",
      link: "/familia",
      studentId: h.studentId,
      now,
    });
    if (h.createdById)
      await repo.notify({
        accountId: h.createdById,
        kind: "HANDOVER_DONE",
        title: `${h.studentName} já gere a própria conta`,
        body: "Aceitou o convite: a partir de agora trata dos seus assuntos no colégio.",
        link: "/familia",
        studentId: h.studentId,
        now,
      });
  }
  return done;
}
