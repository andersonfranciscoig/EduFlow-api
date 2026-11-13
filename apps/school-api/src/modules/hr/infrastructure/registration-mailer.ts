import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { RegistrationMailer, School } from "../application/registration-ports";

const dateFmt = new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Luanda" });

/**
 * Emails do cadastro de funcionários (paleta do portal). Os links nunca levam dados
 * pessoais nem senhas: o convite leva só o token aleatório (na BD fica o hash).
 */
export class EmailRegistrationMailer implements RegistrationMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  private portal(school: School) {
    return this.portalUrlTemplate.replace("{slug}", school.slug);
  }

  /** Corpo comum: cabeçalho com o colégio, parágrafos, botão opcional e nota de rodapé. */
  private html(school: School, greeting: string, paragraphs: string[], cta: { label: string; url: string } | null, note: string) {
    const s = escapeHtml(school.name);
    return `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600;letter-spacing:.2px">EduFlow <span style="color:#8EB69B;font-weight:400">· ${s} · Recursos Humanos</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(greeting)}</p>
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#235347">${p}</p>`).join("\n")}
</td></tr>
<tr><td style="padding:12px 28px 32px">${cta ? `<a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">${escapeHtml(cta.label)}</a>` : ""}
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">${escapeHtml(note)}</p></td></tr>
</table></td></tr></table></body></html>`;
  }

  private first = (name: string) => name.split(" ")[0];

  async requestReceived({ to, school }: Parameters<RegistrationMailer["requestReceived"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `Recebemos o seu pedido de cadastro como funcionário do ${school.name}.`, "Os Recursos Humanos vão analisá-lo; se for aprovado, recebe um email com o link para preencher o cadastro.", "", "Se não foi você, ignore este email."].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [`Recebemos o seu pedido de cadastro como funcionário do <strong>${escapeHtml(school.name)}</strong>.`, "Os Recursos Humanos vão analisá-lo. Se for aprovado, recebe um email com o link para preencher o cadastro."],
      null,
      "Se não foi você, ignore este email.",
    );
    await this.mailer.send({ to, subject: `Pedido de cadastro recebido · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-request-received"] });
  }

  async requestAlreadyOpen({ to, school }: Parameters<RegistrationMailer["requestAlreadyOpen"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `Já existe um pedido de cadastro em curso com este email no ${school.name}, por isso não foi criado outro.`, "Se o pedido já foi aprovado, use o link do email de convite. Se tiver dúvidas, fale com os Recursos Humanos do colégio."].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [`Já existe um pedido de cadastro em curso com este email no <strong>${escapeHtml(school.name)}</strong>, por isso não foi criado outro.`, "Se o pedido já foi aprovado, use o link do email de convite. Se tiver dúvidas, fale com os Recursos Humanos do colégio."],
      null,
      "Se não foi você a pedir, ignore este email.",
    );
    await this.mailer.send({ to, subject: `Já tem um pedido de cadastro · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-request-duplicate"] });
  }

  async newRequestForHr({ to, school, applicant, employeeType }: Parameters<RegistrationMailer["newRequestForHr"]>[0]) {
    const url = `${this.portal(school)}/rh/pedidos`;
    const who = `${applicant}${employeeType ? ` (${employeeType})` : ""}`;
    // um email por pessoa (sem expor os endereços uns aos outros)
    for (const r of to) {
      const text = [`Olá, ${this.first(r.name)}.`, "", `Há um novo pedido de cadastro de funcionário: ${who}.`, `Analise-o no portal: ${url}`].join("\n");
      const html = this.html(school, `Olá, ${this.first(r.name)}.`, [`Há um novo pedido de cadastro de funcionário: <strong>${escapeHtml(who)}</strong>.`], { label: "Ver pedidos de cadastro", url }, "Recebe este aviso porque analisa pedidos de cadastro no portal.");
      await this.mailer.send({ to: r, subject: `Novo pedido de cadastro · ${applicant}`, html, text, tags: ["eduflow-portal", "hr-request-new"] });
    }
  }

  async invite({ to, school, token, expiresAt, employeeType }: Parameters<RegistrationMailer["invite"]>[0]) {
    const url = `${this.portal(school)}/rh/cadastro?convite=${encodeURIComponent(token)}`;
    const until = dateFmt.format(expiresAt);
    const text = [
      `Olá, ${this.first(to.name)}.`,
      "",
      `O seu pedido de cadastro no ${school.name} foi aprovado${employeeType ? ` (${employeeType})` : ""}.`,
      `Preencha o cadastro neste link (válido até ${until}): ${url}`,
      "Para entrar, use a palavra-passe que escolheu ao fazer o pedido. Pode preencher aos poucos: o que escrever fica guardado.",
      "",
      "Não partilhe este link.",
    ].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [
        `O seu pedido de cadastro no <strong>${escapeHtml(school.name)}</strong> foi aprovado${employeeType ? ` (${escapeHtml(employeeType)})` : ""}.`,
        `Preencha o cadastro pelo botão abaixo — o link é válido até <strong>${escapeHtml(until)}</strong>. Para entrar, use a palavra-passe que escolheu ao fazer o pedido. Pode preencher aos poucos: o que escrever fica guardado.`,
      ],
      { label: "Preencher o cadastro", url },
      "Não partilhe este link: é pessoal.",
    );
    await this.mailer.send({ to, subject: `Pedido aprovado — preencha o seu cadastro · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-invite"] });
  }

  async rejected({ to, school, reason }: Parameters<RegistrationMailer["rejected"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `O seu pedido de cadastro no ${school.name} não foi aprovado.`, ...(reason ? [`Motivo: ${reason}`] : []), "Se tiver dúvidas, fale com os Recursos Humanos do colégio."].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [`O seu pedido de cadastro no <strong>${escapeHtml(school.name)}</strong> não foi aprovado.`, ...(reason ? [`Motivo: ${escapeHtml(reason)}`] : []), "Se tiver dúvidas, fale com os Recursos Humanos do colégio."],
      null,
      "EduFlow · portal do colégio",
    );
    await this.mailer.send({ to, subject: `Pedido de cadastro · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-request-rejected"] });
  }
}
