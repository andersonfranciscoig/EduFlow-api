import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../../../config/env";
import { SchoolPayments } from "../application/SchoolPayments";

const EVERY_MS = 60 * 60 * 1000;

/**
 * De hora a hora (e logo ao arrancar): desativa os colégios que se registaram
 * com email pessoal e não passaram a um corporativo no prazo de 30 dias, e trata
 * do fim das subscrições (avisos e, se a equipa o definiu, desativar).
 * Idempotente — várias instâncias a correr só repetem um "não há nada a fazer".
 */
@Injectable()
export class EmailDeadlineSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("EmailDeadlineSweeper");
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly payments: SchoolPayments,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get("JOBS_ENABLED", { infer: true }) !== "true") return this.logger.log("tarefas automáticas desligadas (JOBS_ENABLED=false)");
    const run = () =>
      this.payments
        .sweepEmailDeadlines()
        .then((n) => n && this.logger.log(`${n} colégio(s) desativado(s): prazo do email corporativo terminou`))
        .catch((error: unknown) => this.logger.error(`Falha ao verificar prazos: ${String(error)}`))
        .then(() => this.payments.sweepSubscriptions())
        .then((r) => (r.notices || r.suspended) && this.logger.log(`subscrições: ${r.notices} aviso(s), ${r.suspended} colégio(s) desativado(s)`))
        .catch((error: unknown) => this.logger.error(`Falha ao verificar as subscrições: ${String(error)}`));
    setTimeout(run, 10_000).unref();
    this.timer = setInterval(run, EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
