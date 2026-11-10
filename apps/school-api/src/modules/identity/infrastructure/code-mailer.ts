import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { CodeMailer } from "../application/ports";

const COPY = {
  ACTIVATION: {
    subject: (school: string) => `Ative a sua conta no portal do ${school}`,
    intro: "O portal do seu colégio está pronto. Use este código para ativar a sua conta e definir a sua senha:",
    tag: "activation",
  },
  PASSWORD_RESET: {
    subject: (school: string) => `Código para repor a senha · ${school}`,
    intro: "Pediu para repor a senha do portal. Use este código para continuar:",
    tag: "password-reset",
  },
} as const;

/** Email com o código de 6 dígitos (paleta do portal: verdes #051F20 → #DAF1DE). */
export class EmailCodeMailer implements CodeMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  async sendCode(input: Parameters<CodeMailer["sendCode"]>[0]) {
    const copy = COPY[input.purpose];
    const url = this.portalUrlTemplate.replace("{slug}", input.school.slug);
    const firstName = input.to.name.split(" ")[0];
    const school = escapeHtml(input.school.name);
    const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;

    const text = [
      `Olá, ${firstName}.`,
      "",
      copy.intro,
      "",
      `    ${spaced}`,
      "",
      `O código é válido durante ${input.validMinutes} minutos e só pode ser usado uma vez.`,
      `Portal: ${url}`,
      "",
      "Se não foi você, ignore este email — a sua conta continua protegida.",
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");

    const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600;letter-spacing:.2px">EduFlow <span style="color:#8EB69B;font-weight:400">· ${school}</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">Olá, ${escapeHtml(firstName)}.</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#235347">${copy.intro}</p>
<div style="background:#DAF1DE;border-radius:16px;padding:18px;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:#051F20">${spaced}</div>
<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#235347">Válido durante ${input.validMinutes} minutos e só pode ser usado uma vez.</p>
</td></tr>
<tr><td style="padding:24px 28px 32px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">Abrir o portal</a>
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">Se não foi você, ignore este email — a sua conta continua protegida.</p></td></tr>
</table></td></tr></table></body></html>`;

    await this.mailer.send({ to: input.to, subject: copy.subject(input.school.name), html, text, tags: ["eduflow-portal", copy.tag] });
  }
}
