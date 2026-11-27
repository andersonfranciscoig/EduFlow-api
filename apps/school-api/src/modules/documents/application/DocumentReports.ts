import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type Audience, AUDIENCES, type DocumentsError, documentsError, type RequestStatus, STATUS_LABELS } from "../domain/documents";
import type { PrismaDocumentReports } from "../infrastructure/prisma-document-reports";
import { RECEIVER_RELATIONSHIPS, type ReceiverRelationship, today } from "./DocumentRequests";
import { audiencesFor, type DocumentsViewer } from "./DocumentTypes";
import { canCards } from "./StudentCards";

type R<T> = Promise<Result<T, DocumentsError>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FEE_LABELS: Record<string, string> = { OPEN: "Por pagar", PAID: "Pagas", WAIVED: "Isentas", VOID: "Anuladas" };

/**
 * RELATÓRIO DOS DOCUMENTOS — por público (alunos: secretaria; funcionários: RH) e período: volume
 * por estado, tipo e mês, tempo médio até concluir, cumprimento do prazo, entregas, taxas e cartões.
 * Vê-o quem pode consultar os pedidos desse público.
 */
export class DocumentReports {
  constructor(private readonly clock: Clock) {}

  async report(repo: PrismaDocumentReports, v: DocumentsViewer, q: { audience?: Audience | null; from?: string | null; to?: string | null }): R<unknown> {
    const allowed = audiencesFor(v, "view");
    if (!allowed.length) return fail(documentsError("FORBIDDEN", "Não tem permissão para consultar os pedidos de documentos."));
    const audience = q.audience && allowed.includes(q.audience) ? q.audience : allowed[0];
    const now = today(this.clock.now());
    const to = q.to && DAY.test(q.to) ? q.to : now;
    const from = q.from && DAY.test(q.from) ? q.from : `${now.slice(0, 4)}-01-01`;
    if (from > to) return fail(documentsError("INVALID_INPUT", "A data de início é depois da data de fim."));
    const [totals, statuses, types, months, deliveries, fees, cards] = await Promise.all([
      repo.totals(audience, from, to, now),
      repo.byStatus(audience, from, to),
      repo.byType(audience, from, to),
      repo.byMonth(audience, from, to),
      repo.deliveries(audience, from, to),
      audience === "STUDENT" ? repo.fees(from, to) : Promise.resolve([]),
      audience === "STUDENT" && canCards(v) ? repo.cards(from, to) : Promise.resolve(null),
    ]);
    return ok({
      audience,
      audienceLabel: AUDIENCES[audience],
      audiences: allowed.map((a) => ({ value: a, label: AUDIENCES[a] })),
      from,
      to,
      totals: { ...totals, onTimeRate: totals.completed ? Math.round((totals.onTime / totals.completed) * 100) : null },
      statuses: (Object.keys(STATUS_LABELS) as RequestStatus[]).map((s) => ({ status: s, label: STATUS_LABELS[s], n: statuses.find((x) => x.status === s)?.n ?? 0 })),
      types,
      months,
      deliveries: deliveries.map((d) => ({ relationship: d.relationship, label: RECEIVER_RELATIONSHIPS[d.relationship as ReceiverRelationship] ?? d.relationship, n: d.n })),
      fees: fees.map((f) => ({ status: f.status, label: FEE_LABELS[f.status] ?? f.status, n: f.n, amount: f.amount })),
      cards,
    });
  }
}
