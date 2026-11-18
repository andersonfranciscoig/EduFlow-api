import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { ApplicationsMailer } from "../application/applications-ports";

/** Emails das inscrições para a família (paleta do portal). */
export class EmailApplicationsMailer implements ApplicationsMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  async submitted(input: Parameters<ApplicationsMailer["submitted"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const url = `${this.portalUrlTemplate.replace("{slug}", input.school.slug)}/familia`;
    const what = [input.classLabel, input.yearName].filter(Boolean).join(" · ");
    const text = [
      `Olá, ${firstName}.`,
      "",
      `Recebemos a inscrição de ${input.studentName}${what ? ` (${what})` : ""}.`,
      `N.º do processo: ${input.number}`,
      "",
      "A secretaria vai analisar a inscrição. Se faltar alguma coisa, pedimos as correções por email e na área da família.",
      "A inscrição não garante vaga: a matrícula só fica feita depois da aprovação e da confirmação.",
      "",
      `Acompanhe em: ${url}`,
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");
    const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600">EduFlow <span style="color:#8EB69B;font-weight:400">· ${escapeHtml(input.school.name)} · Inscrições</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">Olá, ${escapeHtml(firstName)}.</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#235347">Recebemos a inscrição de <strong>${escapeHtml(input.studentName)}</strong>${what ? ` (${escapeHtml(what)})` : ""}.</p>
<div style="background:#DAF1DE;border-radius:16px;padding:16px;text-align:center"><div style="font-size:12px;letter-spacing:1px;color:#235347;text-transform:uppercase">N.º do processo</div><div style="margin-top:4px;font-size:24px;font-weight:700;letter-spacing:1px">${escapeHtml(input.number)}</div></div>
<p style="margin:18px 0 0;font-size:13.5px;line-height:1.6;color:#235347">A secretaria vai analisar a inscrição. Se faltar alguma coisa, pedimos as correções por email e na área da família. A inscrição não garante vaga: a matrícula só fica feita depois da aprovação e da confirmação.</p>
</td></tr>
<tr><td style="padding:24px 28px 32px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">Acompanhar a inscrição</a></td></tr>
</table></td></tr></table></body></html>`;
    await this.mailer.send({ to: input.to, subject: `Inscrição recebida (${input.number}) · ${input.school.name}`, html, text, tags: ["eduflow-portal", "application-submitted"] });
  }
}
