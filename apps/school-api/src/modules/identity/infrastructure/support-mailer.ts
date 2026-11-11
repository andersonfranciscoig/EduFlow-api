import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import type { SupportNotifier } from "../application/ports";

const fmt = (d: Date) => d.toLocaleString("pt-AO", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Luanda" });

/** Aviso aos diretores: "a equipa EduFlow entrou no portal" (paleta do portal). */
export class SupportMailer implements SupportNotifier {
  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  async supportStarted(input: Parameters<SupportNotifier["supportStarted"]>[0]) {
    const url = this.portalUrlTemplate.replace("{slug}", input.school.slug);
    const mode = input.mode === "READ" ? "só leitura" : "com permissão de edição";
    const headline = input.emergency ? "Acesso de emergência da equipa EduFlow" : "A equipa EduFlow entrou no portal";
    const why = input.emergency
      ? "Um administrador da EduFlow entrou sem autorização prévia do colégio, por motivo de emergência."
      : "Entrou com a autorização que o colégio deu ao suporte.";

    const text = [
      headline,
      "",
      `${input.staffName} (suporte EduFlow) entrou no portal do ${input.school.name}, em modo ${mode}.`,
      why,
      `Motivo: ${input.reason}`,
      `A sessão termina no máximo às ${fmt(input.expiresAt)}.`,
      "",
      `Pode ver o histórico e retirar o acesso a qualquer momento no portal: ${url}`,
      "",
      `EduFlow · ${input.school.name}`,
    ].join("\n");

    const school = escapeHtml(input.school.name);
    const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600">EduFlow <span style="color:#8EB69B;font-weight:400">· ${school}</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<p style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(headline)}</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#235347"><strong>${escapeHtml(input.staffName)}</strong> (suporte EduFlow) entrou no portal em modo <strong>${mode}</strong>. ${escapeHtml(why)}</p>
<div style="background:#DAF1DE;border-radius:16px;padding:14px 16px;font-size:14px;line-height:1.6;color:#051F20"><strong>Motivo:</strong> ${escapeHtml(input.reason)}<br><strong>Termina até:</strong> ${escapeHtml(fmt(input.expiresAt))}</div>
</td></tr>
<tr><td style="padding:24px 28px 32px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:13px 22px;border-radius:999px">Ver ou retirar o acesso</a>
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">Se não reconhece este acesso, retire-o no portal e contacte a EduFlow.</p></td></tr>
</table></td></tr></table></body></html>`;

    for (const to of input.to) {
      await this.mailer.send({ to, subject: `${headline} · ${input.school.name}`, html, text, tags: ["eduflow-portal", "support-access"] });
    }
  }
}
