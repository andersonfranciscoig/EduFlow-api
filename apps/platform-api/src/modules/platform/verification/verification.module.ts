import { HttpStatus, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateOtpCode, generateProof, hashOtp, hashProof } from "../../../../../../libs/kernel/src/infrastructure/otp";
import { systemClock, uuidGenerator } from "../../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../../config/env";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import { EmailVerificationService } from "./application/EmailVerificationService";
import type { VerificationErrorCode } from "./domain/errors";
import { createMailer, PlatformCodeMailer } from "./infrastructure/platform-mail";
import { PrismaEmailVerificationRepository } from "./infrastructure/PrismaEmailVerificationRepository";

/** Email transacional da plataforma (Brevo; em dev sem chave → consola). */
export const PLATFORM_MAILER = Symbol("PlatformMailer");

export const VERIFICATION_HTTP: Record<VerificationErrorCode, HttpStatus> = {
  INVALID_EMAIL_CODE: HttpStatus.UNAUTHORIZED,
  EMAIL_CODE_EXPIRED: HttpStatus.GONE,
  EMAIL_CODE_COOLDOWN: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_CODE_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_NOT_SENT: HttpStatus.BAD_GATEWAY,
  EMAIL_NOT_VERIFIED: HttpStatus.UNAUTHORIZED,
};

/**
 * Contexto "Verification": códigos por email (criar conta, repor senha).
 * Usado pelos contextos identity (equipa) e schools (responsáveis).
 */
@Module({
  imports: [PlatformDatabaseModule],
  providers: [
    {
      provide: PLATFORM_MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createMailer({
          provider: config.get("EMAIL_PROVIDER", { infer: true }),
          apiKeyFile: config.get("EMAIL_API_KEY_FILE", { infer: true }),
          from: config.get("EMAIL_FROM", { infer: true }),
          fromName: config.get("EMAIL_FROM_NAME", { infer: true }),
          replyTo: config.get("EMAIL_REPLY_TO", { infer: true }),
        }),
    },
    {
      provide: EmailVerificationService,
      inject: [PlatformPrismaService, PLATFORM_MAILER],
      useFactory: (prisma: PlatformPrismaService, mailer: ConstructorParameters<typeof PlatformCodeMailer>[0]) =>
        new EmailVerificationService(
          new PrismaEmailVerificationRepository(prisma),
          new PlatformCodeMailer(mailer),
          { generateCode: generateOtpCode, hashCode: hashOtp, generateProof, hashProof },
          uuidGenerator,
          systemClock,
        ),
    },
  ],
  exports: [EmailVerificationService, PLATFORM_MAILER],
})
export class VerificationModule {}
