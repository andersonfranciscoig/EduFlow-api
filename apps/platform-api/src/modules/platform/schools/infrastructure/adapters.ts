import { randomInt } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import type { PrismaClient } from ".prisma/platform-client";
import type { Mailer } from "../../../../../../../libs/kernel/src/infrastructure/mail";
import { platformEmailHtml } from "../../verification/infrastructure/platform-mail";
import { VALIDATION_HOURS } from "../domain/School";
import type { BillingTeam, CodeGenerator, SchoolNotifier, SchoolTokenService } from "../application/ports";

const day = (d: Date) => d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Luanda" });
const money = (n: number) => `${new Intl.NumberFormat("pt-PT").format(n).replace(/\u00a0/g, " ")} Kz`;

/** A equipa que gere a faturação: administradores e gestores com billing.manage (contas ativas). */
export class PrismaBillingTeam implements BillingTeam {
  constructor(private readonly prisma: PrismaClient) {}

  async emails() {
    const rows = await this.prisma.staffMember.findMany({
      where: { status: "ACTIVE", email: { not: null }, OR: [{ role: "ADMIN" }, { extraPermissions: { has: "billing.manage" } }] },
      select: { email: true, fullName: true },
      take: 50,
    });
    return rows.map((r) => ({ email: r.email!, name: r.fullName }));
  }
}

/** "Colégio ativo": o portal fica pronto em minutos; o responsável ativa a conta com o seu email. */
export class EmailSchoolNotifier implements SchoolNotifier {
  constructor(
    private readonly mailer: Mailer,
    /** endereço do painel/área do colégio */
    private readonly siteUrl: string,
  ) {}

  private async mail(to: { email: string; name: string }, subject: string, paragraphs: string[], button: { label: string; url: string }, footnote: string, tag: string) {
    const heading = `Olá, ${to.name.split(" ")[0]}.`;
    await this.mailer.send({
      to,
      subject: `${subject} · EduFlow`,
      text: [heading, "", ...paragraphs.flatMap((p) => [p, ""]), `${button.label}: ${button.url}`].join("\n"),
      html: platformEmailHtml({ heading, paragraphs, button, footnote }),
      tags: ["eduflow-platform", tag],
    });
  }

  async paymentUpdate(input: Parameters<SchoolNotifier["paymentUpdate"]>[0]) {
    const amount = money(input.total);
    const copy = {
      OPEN: {
        subject: `Pedido validado: falta o pagamento`,
        lines: [
          `O pedido ${input.orderNumber} do ${input.schoolName} foi validado. Falta pagar ${amount}.`,
          "Entre na área do colégio, escolha uma das contas bancárias da EduFlow, faça a transferência ou o depósito e envie o comprovativo com o número da transação.",
        ],
      },
      SUBMITTED: {
        subject: "Recebemos o seu comprovativo",
        lines: [`O pagamento de ${amount} (pedido ${input.orderNumber}) está em validação.`, `A nossa equipa confirma-o em ${VALIDATION_HOURS} horas ou menos. Avisamos por email assim que estiver validado.`],
      },
      REJECTED: { subject: "Pagamento não aceite", lines: [`Não foi possível validar o pagamento de ${amount} (pedido ${input.orderNumber}).`, `Motivo: ${input.reason ?? ""}`, "Confirme os dados e envie um novo comprovativo na área do colégio."] },
      CONFIRMED: {
        subject: input.renewal ? "Subscrição renovada" : "Pagamento validado",
        lines: [`O pagamento de ${amount} (pedido ${input.orderNumber}) foi validado.`, ...(input.renewal && input.until ? [`A subscrição do ${input.schoolName} está ativa até ${day(input.until)}.`] : [])],
      },
    }[input.state];
    if (input.renewal && input.state === "OPEN") copy.subject = "Renovação da subscrição: falta o pagamento";
    if (input.renewal && input.state === "OPEN") copy.lines[0] = `A renovação da subscrição do ${input.schoolName} (pedido ${input.orderNumber}) está à espera do pagamento de ${amount}.`;
    await this.mail(input.to, copy.subject, copy.lines, { label: "Abrir a área do colégio", url: `${this.siteUrl}/colegio` }, "O pagamento só conta depois de validado pela equipa EduFlow.", "school-payment");
  }

  async teamPaymentUpdate(input: Parameters<SchoolNotifier["teamPaymentUpdate"]>[0]) {
    const subject = { SUBMITTED: "Pagamento por validar", REJECTED: "Pagamento recusado", CONFIRMED: "Pagamento validado" }[input.state];
    const lines = [`${input.schoolName}: ${money(input.total)} (pedido ${input.orderNumber}).`, input.detail, ...(input.state === "SUBMITTED" ? [`Prazo da validação: ${VALIDATION_HOURS} horas.`] : [])];
    for (const to of input.to) {
      await this.mail(to, `${subject}: ${input.schoolName}`, lines, { label: "Abrir no painel", url: `${this.siteUrl}/painel/colegios/${input.schoolId}` }, "Recebe este email porque gere a faturação da EduFlow.", "team-payment").catch(() => undefined);
    }
  }

  async subscriptionNotice(input: Parameters<SchoolNotifier["subscriptionNotice"]>[0]) {
    const end = day(input.endsAt);
    const after = input.graceDays === null ? "O portal continua acessível, mas pedimos que renove quanto antes." : `Se não for renovada, o portal fica desativado ${input.graceDays === 0 ? "logo que termine" : `${input.graceDays} dia${input.graceDays === 1 ? "" : "s"} depois`}.`;
    const before = (n: string) => ({ subject: `A subscrição termina ${n}`, lines: [`A subscrição do ${input.schoolName} termina a ${end}.`, "Renove na área do colégio: escolha o plano e a periodicidade, pague por transferência ou depósito e envie o comprovativo.", after] });
    const copy = {
      D30: before("daqui a 30 dias"),
      D15: before("daqui a 15 dias"),
      D7: before("daqui a 7 dias"),
      D1: before("amanhã"),
      EXPIRED: { subject: "A subscrição terminou", lines: [`A subscrição do ${input.schoolName} terminou a ${end}.`, after] },
      E7: { subject: "A subscrição continua por renovar", lines: [`A subscrição do ${input.schoolName} terminou a ${end} e ainda não foi renovada.`, after] },
      SUSPENDED: { subject: `O portal do ${input.schoolName} foi desativado`, lines: [`A subscrição terminou a ${end} e não foi renovada, por isso o portal foi desativado.`, "Os dados continuam guardados. Assim que o pagamento da renovação for validado, o portal volta a abrir."] },
    }[input.stage];
    await this.mail(input.to, copy.subject, copy.lines, { label: "Renovar a subscrição", url: `${this.siteUrl}/colegio` }, "Se já pagou, ignore este aviso: o pagamento é validado em 48 horas ou menos.", "subscription-notice");
  }

  async teamSubscriptionNotice(input: Parameters<SchoolNotifier["teamSubscriptionNotice"]>[0]) {
    const what = { D7: "termina daqui a 7 dias", EXPIRED: "terminou", E7: "terminou há 7 dias e continua por renovar", SUSPENDED: "terminou: o portal foi desativado" }[input.stage] ?? "está a terminar";
    for (const to of input.to) {
      await this.mail(to, `Subscrição do ${input.schoolName}`, [`A subscrição do ${input.schoolName} ${what} (fim: ${day(input.endsAt)}).`], { label: "Abrir no painel", url: `${this.siteUrl}/painel/colegios/${input.schoolId}` }, "Recebe este email porque gere a faturação da EduFlow.", "team-subscription").catch(() => undefined);
    }
  }

  async integrationUpdate(input: Parameters<SchoolNotifier["integrationUpdate"]>[0]) {
    const copy = {
      CONTACTED: `Estamos a tratar do pedido de ${input.methodLabel} do ${input.schoolName}. Entramos em contacto com os próximos passos.`,
      DONE: `O pedido de ${input.methodLabel} do ${input.schoolName} está concluído.`,
      DECLINED: `Para já não é possível avançar com o pedido de ${input.methodLabel} do ${input.schoolName}.`,
    }[input.status];
    await this.mail(input.to, `Pedido de ${input.methodLabel}`, [copy, ...(input.note ? [input.note] : [])], { label: "Abrir a área do colégio", url: `${this.siteUrl}/colegio` }, "Enquanto isso, o colégio continua a receber por transferência ou depósito.", "payment-integration");
  }

  async schoolActivated(input: Parameters<SchoolNotifier["schoolActivated"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const until = input.subscriptionEndsAt ? ` A subscrição está ativa até ${input.subscriptionEndsAt.toLocaleDateString("pt-AO")}.` : "";
    const paragraphs = [
      `O pagamento foi confirmado e o ${input.schoolName} já está ativo na EduFlow.${until}`,
      `O portal do colégio fica pronto dentro de alguns minutos em ${input.portalUrl}.`,
      "No primeiro acesso, entre com este email: enviamos-lhe um código para ativar a conta, criar a senha e proteger o acesso com a verificação em dois passos.",
    ];
    await this.mailer.send({
      to: { email: input.to.email, name: input.to.name },
      subject: `O portal do ${input.schoolName} está pronto · EduFlow`,
      text: [`Olá, ${firstName}.`, "", ...paragraphs.flatMap((p) => [p, ""]), `Portal: ${input.portalUrl}`].join("\n"),
      html: platformEmailHtml({
        heading: `Olá, ${firstName}.`,
        paragraphs,
        button: { label: "Abrir o portal do colégio", url: input.portalUrl },
        footnote: "Guarde este endereço: é o acesso do seu colégio à EduFlow.",
      }),
      tags: ["eduflow-platform", "school-activated"],
    });
  }

  async schoolSuspended(input: Parameters<SchoolNotifier["schoolSuspended"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const paragraphs = [
      `O ${input.schoolName} foi desativado na EduFlow: ${input.reason}`,
      "Para voltar a ativá-lo, entre na área do colégio, passe a usar o email corporativo do colégio e fale com a equipa EduFlow.",
    ];
    await this.mailer.send({
      to: { email: input.to.email, name: input.to.name },
      subject: `O ${input.schoolName} foi desativado · EduFlow`,
      text: [`Olá, ${firstName}.`, "", ...paragraphs.flatMap((p) => [p, ""])].join("\n"),
      html: platformEmailHtml({ heading: `Olá, ${firstName}.`, paragraphs, footnote: "Os dados do colégio continuam guardados." }),
      tags: ["eduflow-platform", "school-suspended"],
    });
  }
}

const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:school-owner";

/** Tokens do responsável do colégio — audiência diferente da equipa interna. */
export class JwtSchoolTokenService implements SchoolTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issue(schoolId: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: schoolId, kind: "school-owner" },
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds },
    );
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; kind?: string }>(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
      });
      return payload.kind === "school-owner" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

export const randomCodes: CodeGenerator = {
  orderNumber(now: Date) {
    const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
    return `EF-${ymd}-${String(randomInt(0, 100_000)).padStart(5, "0")}`;
  },
  referenceNumber() {
    return String(randomInt(100_000_000, 1_000_000_000));
  },
};
