import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { FamilyMailer } from "../application/ports";
import type { CodePurpose } from "../domain/family";

const COPY: Record<CodePurpose, { subject: (school: string) => string; intro: string; tag: string }> = {
  ACTIVATION: {
    subject: (school) => `Ative a sua conta da família · ${school}`,
    intro: "Está a criar a sua conta na área da família do colégio. Use este código para a ativar:",
    tag: "family-activation",
  },
  LOGIN: {
    subject: (school) => `Código para entrar · ${school}`,
    intro: "Está a entrar na área da família. Use este código para concluir a entrada:",
    tag: "family-login",
  },
  RECOVERY: {
    subject: (school) => `Código para repor a senha · ${school}`,
    intro: "Pediu para repor a senha da área da família. Use este código para continuar:",
    tag: "family-recovery",
  },
};

const frame = (school: string, body: string, url: string) => `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600;letter-spacing:.2px">EduFlow <span style="color:#8EB69B;font-weight:400">· ${school} · Área da família</span></td></tr>
<tr><td style="padding:32px 28px 8px">${body}</td></tr>
<tr><td style="padding:24px 28px 32px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">Abrir a área da família</a>
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">Se não foi você, ignore este email — a sua conta continua protegida.</p></td></tr>
</table></td></tr></table></body></html>`;

/** Emails das contas de família (paleta do portal). */
export class EmailFamilyMailer implements FamilyMailer {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  private url(slug: string) {
    return `${this.portalUrlTemplate.replace("{slug}", slug)}/familia`;
  }

  async sendCode(input: Parameters<FamilyMailer["sendCode"]>[0]) {
    const copy = COPY[input.purpose];
    const firstName = input.to.name.split(" ")[0];
    const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;
    const url = this.url(input.school.slug);
    const text = [
      `Olá, ${firstName}.`,
      "",
      copy.intro,
      "",
      `    ${spaced}`,
      "",
      `O código é válido durante ${input.validMinutes} minutos e só pode ser usado uma vez.`,
      `Área da família: ${url}`,
      "",
      "Se não foi você, ignore este email — a sua conta continua protegida.",
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");
    const body = `<p style="margin:0 0 12px;font-size:20px;font-weight:600">Olá, ${escapeHtml(firstName)}.</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#235347">${copy.intro}</p>
<div style="background:#DAF1DE;border-radius:16px;padding:18px;text-align:center;font-size:32px;font-weight:700;letter-spacing:10px;color:#051F20">${spaced}</div>
<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#235347">Válido durante ${input.validMinutes} minutos e só pode ser usado uma vez.</p>`;
    await this.mailer.send({ to: input.to, subject: copy.subject(input.school.name), html: frame(escapeHtml(input.school.name), body, url), text, tags: ["eduflow-portal", copy.tag] });
  }

  async alreadyRegistered(input: Parameters<FamilyMailer["alreadyRegistered"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const url = this.url(input.school.slug);
    const text = [
      `Olá, ${firstName}.`,
      "",
      "Alguém tentou criar uma conta da área da família com este email, mas já tem uma conta.",
      `Entre em ${url} com o seu email e senha. Se se esqueceu da senha, use "Esqueci-me da senha".`,
      "",
      "Se não foi você, ignore este email — a sua conta continua protegida.",
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");
    const body = `<p style="margin:0 0 12px;font-size:20px;font-weight:600">Olá, ${escapeHtml(firstName)}.</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#235347">Alguém tentou criar uma conta da área da família com este email, mas <strong>já tem uma conta</strong>.</p>
<p style="margin:0;font-size:15px;line-height:1.6;color:#235347">Entre com o seu email e senha. Se se esqueceu da senha, use “Esqueci-me da senha”.</p>`;
    await this.mailer.send({ to: input.to, subject: `Já tem conta na área da família · ${input.school.name}`, html: frame(escapeHtml(input.school.name), body, url), text, tags: ["eduflow-portal", "family-exists"] });
  }
}
