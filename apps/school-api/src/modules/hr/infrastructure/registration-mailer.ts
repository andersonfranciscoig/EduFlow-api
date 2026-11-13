import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { EmployeeMailer } from "../application/employee-ports";
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

  // ================================================================ cadastro (EmployeeMailer)

  async submittedForHr({ to, school, employee, employeeId, resubmitted }: Parameters<EmployeeMailer["submittedForHr"]>[0]) {
    const url = `${this.portal(school)}/rh/funcionarios/${employeeId}`;
    const what = resubmitted ? "corrigiu e voltou a submeter o cadastro" : "submeteu o cadastro";
    for (const r of to) {
      const text = [`Olá, ${this.first(r.name)}.`, "", `${employee} ${what}. Está à espera de análise.`, `Ver no portal: ${url}`].join("\n");
      const html = this.html(school, `Olá, ${this.first(r.name)}.`, [`<strong>${escapeHtml(employee)}</strong> ${what}. Está à espera de análise.`], { label: "Analisar o cadastro", url }, "Recebe este aviso porque aprova cadastros de funcionários no portal.");
      await this.mailer.send({ to: r, subject: `Cadastro por analisar · ${employee}`, html, text, tags: ["eduflow-portal", "hr-employee-submitted"] });
    }
  }

  async submittedConfirmation({ to, school }: Parameters<EmployeeMailer["submittedConfirmation"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `Recebemos o seu cadastro no ${school.name}. Os Recursos Humanos vão analisá-lo e recebe um email com a decisão.`].join("\n");
    const html = this.html(school, `Olá, ${this.first(to.name)}.`, [`Recebemos o seu cadastro no <strong>${escapeHtml(school.name)}</strong>.`, "Os Recursos Humanos vão analisá-lo e recebe um email com a decisão."], null, "EduFlow · portal do colégio");
    await this.mailer.send({ to, subject: `Cadastro recebido · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-employee-received"] });
  }

  async approved({ to, school, number }: Parameters<EmployeeMailer["approved"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `O seu cadastro no ${school.name} foi aprovado.`, ...(number ? [`O seu n.º de funcionário é ${number}.`] : []), "Os Recursos Humanos tratam consigo dos passos seguintes."].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [`O seu cadastro no <strong>${escapeHtml(school.name)}</strong> foi aprovado.`, ...(number ? [`O seu n.º de funcionário é <strong>${escapeHtml(number)}</strong>.`] : []), "Os Recursos Humanos tratam consigo dos passos seguintes."],
      null,
      "EduFlow · portal do colégio",
    );
    await this.mailer.send({ to, subject: `Cadastro aprovado · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-employee-approved"] });
  }

  async employeeRejected({ to, school, reason }: Parameters<EmployeeMailer["rejected"]>[0]) {
    const text = [`Olá, ${this.first(to.name)}.`, "", `O seu cadastro no ${school.name} não foi aprovado.`, ...(reason ? [`Motivo: ${reason}`] : []), "Se tiver dúvidas, fale com os Recursos Humanos do colégio."].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [`O seu cadastro no <strong>${escapeHtml(school.name)}</strong> não foi aprovado.`, ...(reason ? [`Motivo: ${escapeHtml(reason)}`] : []), "Se tiver dúvidas, fale com os Recursos Humanos do colégio."],
      null,
      "EduFlow · portal do colégio",
    );
    await this.mailer.send({ to, subject: `Cadastro · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-employee-rejected"] });
  }

  async correctionRequested({ to, school, note, token, expiresAt }: Parameters<EmployeeMailer["correctionRequested"]>[0]) {
    const url = `${this.portal(school)}/rh/cadastro?convite=${encodeURIComponent(token)}`;
    const until = dateFmt.format(expiresAt);
    const text = [
      `Olá, ${this.first(to.name)}.`,
      "",
      `Os Recursos Humanos do ${school.name} pedem-lhe correções no cadastro:`,
      note,
      "",
      `Corrija neste link (válido até ${until}), com a mesma palavra-passe: ${url}`,
      "O link anterior deixou de valer. Não partilhe este link.",
    ].join("\n");
    const html = this.html(
      school,
      `Olá, ${this.first(to.name)}.`,
      [
        `Os Recursos Humanos do <strong>${escapeHtml(school.name)}</strong> pedem-lhe correções no cadastro:`,
        `<span style="display:block;border-left:3px solid #8EB69B;padding:4px 0 4px 12px;color:#051F20">${escapeHtml(note)}</span>`,
        `Corrija pelo botão abaixo (válido até <strong>${escapeHtml(until)}</strong>), com a mesma palavra-passe. O link anterior deixou de valer.`,
      ],
      { label: "Corrigir o cadastro", url },
      "Não partilhe este link: é pessoal.",
    );
    await this.mailer.send({ to, subject: `Correções no cadastro · ${school.name}`, html, text, tags: ["eduflow-portal", "hr-employee-correction"] });
  }

  async inviteExpiredForHr({ to, school, applicant }: Parameters<EmployeeMailer["inviteExpiredForHr"]>[0]) {
    const url = `${this.portal(school)}/rh/pedidos?estado=APPROVED`;
    for (const r of to) {
      const text = [`Olá, ${this.first(r.name)}.`, "", `${applicant} tentou abrir o convite de cadastro, mas o link já expirou.`, `Pode reenviar o convite no portal: ${url}`].join("\n");
      const html = this.html(school, `Olá, ${this.first(r.name)}.`, [`<strong>${escapeHtml(applicant)}</strong> tentou abrir o convite de cadastro, mas o link já expirou.`], { label: "Reenviar o convite", url }, "Recebe este aviso porque aprova pedidos de cadastro no portal.");
      await this.mailer.send({ to: r, subject: `Convite expirado · ${applicant}`, html, text, tags: ["eduflow-portal", "hr-invite-expired"] });
    }
  }
}

/**
 * Os emails do cadastro com a forma que o caso de uso espera (o "rejected" do pedido e o
 * do cadastro têm textos diferentes, por isso vivem com nomes distintos na classe acima).
 */
export const employeeMailer = (m: EmailRegistrationMailer): EmployeeMailer => ({
  submittedForHr: (i) => m.submittedForHr(i),
  submittedConfirmation: (i) => m.submittedConfirmation(i),
  approved: (i) => m.approved(i),
  rejected: (i) => m.employeeRejected(i),
  correctionRequested: (i) => m.correctionRequested(i),
  inviteExpiredForHr: (i) => m.inviteExpiredForHr(i),
});
