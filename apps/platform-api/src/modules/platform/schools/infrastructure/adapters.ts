import { randomInt } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import type { Mailer } from "../../../../../../../libs/kernel/src/infrastructure/mail";
import { platformEmailHtml } from "../../verification/infrastructure/platform-mail";
import type { CodeGenerator, SchoolNotifier, SchoolTokenService } from "../application/ports";

/** "Colégio ativo": o portal fica pronto em minutos; o responsável ativa a conta com o seu email. */
export class EmailSchoolNotifier implements SchoolNotifier {
  constructor(private readonly mailer: Mailer) {}

  async schoolActivated(input: Parameters<SchoolNotifier["schoolActivated"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const until = input.subscriptionEndsAt ? ` A subscrição está ativa até ${input.subscriptionEndsAt.toLocaleDateString("pt-AO")}.` : "";
    const paragraphs = [
      `O pagamento foi confirmado e o ${input.schoolName} já está ativo na EduFlow.${until}`,
      `O portal do colégio fica pronto dentro de alguns minutos em ${input.portalUrl}.`,
      "No primeiro acesso, entre com este email: enviamos-lhe um código para ativar a conta, criar a senha e proteger o acesso com a verificação em dois passos.",
    ];
    await this.mailer.send({
      to: { email: input.to.email, name: input.to.name },
      subject: `O portal do ${input.schoolName} está pronto · EduFlow`,
      text: [`Olá, ${firstName}.`, "", ...paragraphs.flatMap((p) => [p, ""]), `Portal: ${input.portalUrl}`].join("\n"),
      html: platformEmailHtml({
        heading: `Olá, ${firstName}.`,
        paragraphs,
        button: { label: "Abrir o portal do colégio", url: input.portalUrl },
        footnote: "Guarde este endereço: é o acesso do seu colégio à EduFlow.",
      }),
      tags: ["eduflow-platform", "school-activated"],
    });
  }

  async schoolSuspended(input: Parameters<SchoolNotifier["schoolSuspended"]>[0]) {
    const firstName = input.to.name.split(" ")[0];
    const paragraphs = [
      `O ${input.schoolName} foi desativado na EduFlow: ${input.reason}`,
      "Para voltar a ativá-lo, entre na área do colégio, passe a usar o email corporativo do colégio e fale com a equipa EduFlow.",
    ];
    await this.mailer.send({
      to: { email: input.to.email, name: input.to.name },
      subject: `O ${input.schoolName} foi desativado · EduFlow`,
      text: [`Olá, ${firstName}.`, "", ...paragraphs.flatMap((p) => [p, ""])].join("\n"),
      html: platformEmailHtml({ heading: `Olá, ${firstName}.`, paragraphs, footnote: "Os dados do colégio continuam guardados." }),
      tags: ["eduflow-platform", "school-suspended"],
    });
  }
}

const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:school-owner";

/** Tokens do responsável do colégio — audiência diferente da equipa interna. */
export class JwtSchoolTokenService implements SchoolTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issue(schoolId: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: schoolId, kind: "school-owner" },
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds },
    );
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; kind?: string }>(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
      });
      return payload.kind === "school-owner" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

export const randomCodes: CodeGenerator = {
  orderNumber(now: Date) {
    const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
    return `EF-${ymd}-${String(randomInt(0, 100_000)).padStart(5, "0")}`;
  },
  referenceNumber() {
    return String(randomInt(100_000_000, 1_000_000_000));
  },
};
