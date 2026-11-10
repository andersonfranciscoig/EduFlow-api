import { readKeyFile } from "../../../../../../../libs/kernel/src/infrastructure/keys";
import { BrevoMailer, ConsoleMailer, escapeHtml, type Mailer } from "../../../../../../../libs/kernel/src/infrastructure/mail";
import type { VerificationCodeMailer } from "../application/EmailVerificationService";
import type { VerificationPurpose } from "../domain/EmailVerification";

export function createMailer(config: {
  provider: "brevo" | "console";
  apiKeyFile?: string;
  from: string;
  fromName: string;
  replyTo: string;
}): Mailer {
  return config.provider === "brevo" && config.apiKeyFile
    ? new BrevoMailer(readKeyFile(config.apiKeyFile), { from: config.from, fromName: config.fromName, replyTo: config.replyTo })
    : new ConsoleMailer();
}

/** Moldura dos emails da plataforma (paleta do painel: #06141B → #CCD0CF). */
export function platformEmailHtml(input: { heading: string; paragraphs: string[]; code?: string; button?: { label: string; url: string }; footnote: string }) {
  const code = input.code
    ? `<div style="background:#CCD0CF;border-radius:16px;padding:18px;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:#06141B">${input.code}</div>`
    : "";
  const button = input.button
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(input.button.url)}" style="display:inline-block;background:#11212D;color:#CCD0CF;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">${escapeHtml(input.button.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="pt"><body style="margin:0;background:#CCD0CF;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#06141B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#06141B;padding:22px 28px;color:#CCD0CF;font-size:15px;font-weight:600;letter-spacing:.2px">EduFlow</td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(input.heading)}</p>
${input.paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#253745">${escapeHtml(p)}</p>`).join("")}
${code}${button}
</td></tr>
<tr><td style="padding:20px 28px 32px"><p style="margin:0;font-size:12px;line-height:1.6;color:#4A5C6A">${escapeHtml(input.footnote)}</p></td></tr>
</table></td></tr></table></body></html>`;
}

const COPY: Record<VerificationPurpose, { subject: string; intro: string }> = {
  STAFF_SIGN_UP: { subject: "Confirme o seu email · EduFlow", intro: "Está a criar uma conta na equipa EduFlow. Use este código para confirmar o seu email:" },
  STAFF_PASSWORD_RESET: { subject: "Código para repor a senha · EduFlow", intro: "Pediu para repor a senha da sua conta da equipa EduFlow. Use este código:" },
  SCHOOL_SIGN_UP: { subject: "Confirme o email do colégio · EduFlow", intro: "Está a registar o seu colégio na EduFlow. Use este código para confirmar o email corporativo:" },
  SCHOOL_PASSWORD_RESET: { subject: "Código para repor a senha · EduFlow", intro: "Pediu para repor a senha da área do colégio na EduFlow. Use este código:" },
  SCHOOL_EMAIL_CHANGE: {
    subject: "Confirme o novo email do colégio · EduFlow",
    intro: "Pediu para passar a usar este email corporativo na conta do colégio na EduFlow. Use este código para o confirmar:",
  },
};

export class PlatformCodeMailer implements VerificationCodeMailer {
  constructor(private readonly mailer: Mailer) {}

  async send(input: Parameters<VerificationCodeMailer["send"]>[0]) {
    const copy = COPY[input.purpose];
    const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
    const greeting = input.to.name ? `Olá, ${input.to.name.split(" ")[0]}.` : "Olá.";
    const footnote = "Se não foi você, ignore este email — nada muda na sua conta.";
    const validity = `O código é válido durante ${input.validMinutes} minutos e só pode ser usado uma vez.`;
    await this.mailer.send({
      to: { email: input.to.email, name: input.to.name ?? undefined },
      subject: copy.subject,
      text: [greeting, "", copy.intro, "", `    ${spaced}`, "", validity, "", footnote].join("\n"),
      html: platformEmailHtml({ heading: greeting, paragraphs: [copy.intro], code: spaced, footnote: `${validity} ${footnote}` }),
      tags: ["eduflow-platform", input.purpose.toLowerCase()],
    });
  }
}
