import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { luandaToday } from "../../family/domain/family";
import { KINDS } from "../../notifications/domain/catalog";
import { kz, lateFee, type PaymentError, paymentError } from "../domain/payments";
import type { PrismaPaymentsRepository } from "../infrastructure/prisma-payments";
import type { DueReminder, PrismaRemindersRepository } from "../infrastructure/prisma-reminders";
import type { PaymentActor, PaymentChannels } from "./Payments";

const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Lembretes das propinas: automáticos (antes, no dia e em atraso) e os que as Finanças enviam à mão. */
export class Reminders {
  constructor(private readonly clock: Clock) {}

  /** A volta do dia, a partir da hora escolhida. null = ainda não é hora, ou está desligado. */
  async daily(pay: PrismaPaymentsRepository, repo: PrismaRemindersRepository, ch: Pick<PaymentChannels, "familyEmail">, hour: number): Promise<number | null> {
    const s = await pay.settings();
    if (!s.transferEnabled || !s.remindersEnabled || hour < s.remindHour || hour >= 21) return null;
    const today = luandaToday(this.clock.now());
    const list = await repo.due(today, { beforeDays: s.remindBeforeDays, onDue: s.remindOnDue, everyDays: s.remindEveryDays, max: s.remindMax });
    return this.send(pay, await repo.claim(list, today, null, this.clock.now()), ch, today);
  }

  /** As Finanças lembram agora uma cobrança, ou todas as propinas em atraso (no máximo um lembrete por dia a cada família). */
  async now(pay: PrismaPaymentsRepository, repo: PrismaRemindersRepository, actor: PaymentActor, ch: Pick<PaymentChannels, "familyEmail">, chargeIds: string[] | null): Promise<Result<{ families: number; charges: number }, PaymentError>> {
    if (!actor.canCharge) return fail(paymentError("FORBIDDEN", "Não tem permissão para enviar lembretes."));
    if (!(await pay.settings()).transferEnabled) return fail(paymentError("PAYMENTS_OFF", "Os pagamentos estão desligados."));
    const now = this.clock.now();
    const today = luandaToday(now);
    const list = await repo.claim(await repo.manual(today, chargeIds), today, actor.id, now);
    if (!list.length) return fail(paymentError("INVALID_STATE", chargeIds ? "Esta família já recebeu hoje um lembrete desta cobrança, ou não tem conta na área da família." : "Não há propinas em atraso por lembrar hoje."));
    for (const id of new Set(list.map((x) => x.chargeId))) await pay.record("CHARGE_REMINDED", id, actor.id, {}, now);
    void this.send(pay, list, ch, today).catch((e: unknown) => console.error(`[lembretes] ${e instanceof Error ? e.message : String(e)}`));
    return ok({ families: new Set(list.map((x) => x.accountId)).size, charges: new Set(list.map((x) => x.chargeId)).size });
  }

  /** Um aviso por família, com tudo o que tem a pagar. */
  private async send(pay: PrismaPaymentsRepository, list: DueReminder[], ch: Pick<PaymentChannels, "familyEmail">, today: string): Promise<number> {
    const families = new Map<string, DueReminder[]>();
    for (const x of list) families.set(x.accountId, [...(families.get(x.accountId) ?? []), x]);
    if (!families.size) return 0;
    const type = await pay.familyType("PAYMENT_REMINDER");
    if (!(type?.enabled ?? KINDS.PAYMENT_REMINDER.defaultEnabled)) return 0;
    const email = type?.email ?? KINDS.PAYMENT_REMINDER.defaultEmail;
    for (const [accountId, items] of families) {
      const rows = items.map((x) => {
        const fee = lateFee(x.amount, x.dueOn, today, x.planKind ? { kind: x.planKind, value: x.planValue ?? 0 } : null);
        return { ...x, fee, total: x.amount + fee };
      });
      const total = rows.reduce((n, r) => n + r.total, 0);
      const late = rows.filter((r) => r.dueOn && r.dueOn < today);
      const next = rows.filter((r) => r.dueOn && r.dueOn >= today).map((r) => r.dueOn!).sort()[0];
      const title = late.length ? `Propinas em atraso · ${kz(total)}` : next === today ? `Propina vence hoje · ${kz(total)}` : next ? `Propina a vencer a ${dm(next)} · ${kz(total)}` : `Valores por pagar · ${kz(total)}`;
      const lines = rows.map((r) => `${r.studentName}: ${r.label}, ${kz(r.amount)}${r.fee ? ` + multa ${kz(r.fee)}` : ""}${r.dueOn ? ` (${r.dueOn < today ? "venceu" : "vence"} a ${dm(r.dueOn)})` : ""}`);
      const body = `${lines.slice(0, 4).join("; ")}${lines.length > 4 ? `; e mais ${lines.length - 4}` : ""}. Pague por transferência ou depósito e envie o comprovativo.`;
      const link = `/familia/pagamentos?passo=pagar&cobrancas=${[...new Set(rows.map((r) => r.chargeId))].slice(0, 20).join(",")}`;
      const now = this.clock.now();
      await pay.remindFamily(accountId, title, body, link, items.length === 1 ? items[0].studentId : null, now);
      if (!email) continue;
      const { email: address, fullName } = items[0];
      const log = (status: "SENT" | "FAILED" | "SKIPPED", error: string | null) => pay.logFamilyEmail({ accountId, fullName, title, destination: address, status, error, now, kind: "PAYMENT_REMINDER" });
      if (!(await pay.familyWantsEmail(accountId, "PAYMENT_REMINDER"))) {
        await log("SKIPPED", "Recusado nas preferências");
        continue;
      }
      try {
        await ch.familyEmail({ to: { email: address, name: fullName }, title, body: "Se já pagou, ignore este lembrete: o pagamento é validado pelas Finanças do colégio.", link, sections: [{ title: "Por pagar", lines }], kind: "PAYMENT_REMINDER" });
        await log("SENT", null);
      } catch (e) {
        await log("FAILED", String((e as Error).message).slice(0, 300));
      }
    }
    return families.size;
  }
}
