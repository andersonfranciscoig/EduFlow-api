import type { Mailer } from "../../../../../../../libs/kernel/src/infrastructure/mail";
import { platformEmailHtml } from "../../verification/infrastructure/platform-mail";
import type { InvitationMailer } from "../application/use-cases/StaffInvitations";

/** "Foi convidado para a equipa EduFlow" com o link para criar a conta. */
export class EmailInvitationMailer implements InvitationMailer {
  constructor(private readonly mailer: Mailer) {}

  async send(input: Parameters<InvitationMailer["send"]>[0]) {
    const until = input.expiresAt.toLocaleDateString("pt-AO", { day: "numeric", month: "long" });
    const paragraphs = [
      `${input.invitedBy} convidou-o para a equipa EduFlow como ${input.roleLabel}.`,
      `Use o botão abaixo para criar a sua conta (válido até ${until}). No fim vai configurar a verificação em dois passos na app de autenticação do telemóvel.`,
    ];
    await this.mailer.send({
      to: { email: input.to },
      subject: "Convite para a equipa EduFlow",
      text: ["Olá.", "", ...paragraphs.flatMap((p) => [p, ""]), `Criar conta: ${input.link}`].join("\n"),
      html: platformEmailHtml({
        heading: "Olá.",
        paragraphs,
        button: { label: "Criar a minha conta", url: input.link },
        footnote: "Se não esperava este convite, ignore este email. O link é pessoal — não o partilhe.",
      }),
      tags: ["eduflow-platform", "staff-invitation"],
    });
  }
}
