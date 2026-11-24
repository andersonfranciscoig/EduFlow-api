-- =============================================================================
--  QUANDO SE PAGA CADA RUBRICA DO PREÇÁRIO.
--
--  fee_items.charged_at
--      INSCRICAO   paga-se ao fazer a inscrição (ex.: taxa de inscrição)
--      MATRICULA   paga-se no ato da matrícula / renovação (ex.: matrícula, confirmação,
--                  uniforme, cartão de estudante); numa rubrica mensal = a 1.ª mensalidade
--      DURANTE     cobrada durante o ano (a propina mensal, pelo calendário das propinas)
--  As rubricas que já existem: as únicas passam a MATRICULA (a Matrícula e a Confirmação
--  de partida, e as que o colégio criou); as mensais ficam DURANTE. O colégio ajusta no preçário.
--  Preço 0 = gratuito. (O pagamento em si ainda não existe: só se mostra o que é devido.)
-- =============================================================================
ALTER TABLE "fee_items" ADD COLUMN "charged_at" TEXT NOT NULL DEFAULT 'DURANTE';
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_charged_at_check" CHECK ("charged_at" IN ('INSCRICAO', 'MATRICULA', 'DURANTE'));
UPDATE "fee_items" SET "charged_at" = 'MATRICULA' WHERE "billing" = 'UNICA';
