import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { SchoolPayments } from "../application/SchoolPayments";

const EVERY_MS = 60 * 60 * 1000;

/**
 * De hora a hora (e logo ao arrancar): desativa os colégios que se registaram
 * com email pessoal e não passaram a um corporativo no prazo de 30 dias.
 * Idempotente — várias instâncias a correr só repetem um "não há nada a fazer".
 */
@Injectable()
export class EmailDeadlineSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("EmailDeadlineSweeper");
  private timer?: NodeJS.Timeout;

  constructor(private readonly payments: SchoolPayments) {}

  onApplicationBootstrap() {
    const run = () =>
      this.payments
        .sweepEmailDeadlines()
        .then((n) => n && this.logger.log(`${n} colégio(s) desativado(s): prazo do email corporativo terminou`))
        .catch((error: unknown) => this.logger.error(`Falha ao verificar prazos: ${String(error)}`));
    setTimeout(run, 10_000).unref();
    this.timer = setInterval(run, EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
