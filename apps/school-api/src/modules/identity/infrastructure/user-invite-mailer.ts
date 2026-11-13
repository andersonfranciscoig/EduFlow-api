import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { UserInviteMailer } from "../application/ManageUsers";

/**
 * Convite para o portal do colégio. Não leva códigos nem senhas: a pessoa entra
 * no portal com o seu email e ativa a conta (código por email → senha → 2FA).
 */
export class EmailUserInviteMailer implements UserInviteMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  async sendInvite(input: Parameters<UserInviteMailer["sendInvite"]>[0]) {
    const url = `${this.portalUrlTemplate.replace("{slug}", input.school.slug)}/entrar`;
    const firstName = input.to.name.split(" ")[0];
    const school = escapeHtml(input.school.name);

    const text = [
      `Olá, ${firstName}.`,
      "",
      `${input.invitedBy} convidou-o(a) para o portal do ${input.school.name}, com o papel de ${input.roleLabel}.`,
      "",
      `Para ativar a conta, abra ${url}, escreva este email (${input.to.email}) e siga os passos: recebe um código, define a sua senha e configura a verificação em dois passos.`,
      "",
      "Se não esperava este convite, ignore este email.",
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");

    const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600;letter-spacing:.2px">EduFlow <span style="color:#8EB69B;font-weight:400">· ${school}</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">Olá, ${escapeHtml(firstName)}.</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#235347">${escapeHtml(input.invitedBy)} convidou-o(a) para o portal do <strong>${school}</strong>, com o papel de <strong>${escapeHtml(input.roleLabel)}</strong>.</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#235347">Para ativar a conta, entre no portal com este email (<strong>${escapeHtml(input.to.email)}</strong>): recebe um código, define a sua senha e configura a verificação em dois passos.</p>
</td></tr>
<tr><td style="padding:24px 28px 32px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">Ativar a conta</a>
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">Se não esperava este convite, ignore este email.</p></td></tr>
</table></td></tr></table></body></html>`;

    await this.mailer.send({ to: input.to, subject: `Convite para o portal do ${input.school.name}`, html, text, tags: ["eduflow-portal", "user-invite"] });
  }
}
