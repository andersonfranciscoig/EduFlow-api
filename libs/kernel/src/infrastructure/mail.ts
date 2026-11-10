import { Logger } from "@nestjs/common";

/** Envio de email transacional (porta + adaptadores). */
export interface MailMessage {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
  tags?: string[];
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface MailSettings {
  from: string;
  fromName: string;
  replyTo: string;
}

/**
 * Brevo (API HTTP v3) — o mesmo serviço usado no PASSA.
 * A chave vem de um ficheiro (secrets/), nunca do código nem dos logs.
 */
export class BrevoMailer implements Mailer {
  private readonly logger = new Logger("BrevoMailer");

  constructor(
    private readonly apiKey: string,
    private readonly settings: MailSettings,
  ) {
    if (!apiKey.trim()) throw new Error("Chave da API do Brevo em falta (EMAIL_API_KEY_FILE).");
  }

  async send(message: MailMessage): Promise<void> {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey.trim(), "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: this.settings.fromName, email: this.settings.from },
        to: [{ email: message.to.email, name: message.to.name ?? message.to.email }],
        replyTo: { email: this.settings.replyTo, name: this.settings.fromName },
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        tags: message.tags,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error(`Brevo respondeu ${res.status}: ${body.slice(0, 300)}`);
      throw new Error(`Falha no envio de email (${res.status}).`);
    }
  }
}

/** Desenvolvimento sem envio real: mostra o email na consola. */
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger("ConsoleMailer");

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`\n── email para ${message.to.email} ──\nAssunto: ${message.subject}\n\n${message.text}\n──`);
  }
}

/** Escapa texto para inserir em HTML de emails. */
export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
