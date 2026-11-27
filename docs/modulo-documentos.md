# Módulo de solicitação, emissão e gestão de documentos

Relatório final do módulo (fases D1 a D8, novembro de 2026). Cada colégio escolhe que documentos
disponibiliza, como se emitem, em que prazo e com que taxa. A emissão automática e a produção
externa coexistem, tipo a tipo. O **school-api decide tudo** (estados, permissões, relações
família ↔ aluno, ficheiros); o portal só mostra e envia.

## 1. Funcionalidades

| Fase | O que entrega |
|---|---|
| D1 | Tipos de documento por colégio: público (alunos ou funcionários), departamento (Secretaria, Pedagogia, RH), categoria, método (automático ou preparado pelo colégio), levantamento e/ou download, prazo, aprovação, campos extra e requisitos; documentos sugeridos; ativar, desativar e apagar (só sem pedidos). |
| D2 | Pedidos com número único `DOC-<ano>-<n.º>`, cópia do tipo e do beneficiário, máquina de estados validada no backend (Pendente → Em análise → Aguarda pagamento → Em processamento → Disponível para levantamento/download → Concluído; Rejeitado e Cancelado com motivo), histórico e notas (internas ou para quem pediu). |
| D3 | Painéis da Secretaria e do RH (estados, pesquisa por nome, n.º de aluno, turma, classe, tipo, n.º do pedido e período; pedido ao balcão) e confirmação da entrega (quem recebeu é obrigatório, com a relação e, se autorizado, o documento de identificação). Família: catálogo por educando, pedido por passos, lista e detalhe. Funcionário: os seus documentos profissionais. |
| D4 | Emissão automática: modelos por tipo, com versões e campos `{{...}}` (colégio, aluno, matrícula, funcionário e campos do pedido), pré-visualização com dados de exemplo e PDF (pdf-lib) com logótipo, assinatura, carimbo, número e versão. Dados em falta impedem a emissão. Segunda via e substituição com motivo; versões guardadas. |
| D5 | Documento preparado fora: PDF, JPG ou PNG até 10 MB, com o tipo real verificado; guardado cifrado no armazenamento do próprio colégio; downloads só pela API, com registo no histórico. O primeiro download de um documento "para download" conclui o pedido. |
| D6 | Taxas por tipo (só alunos): cobrança `DOCUMENTO` nas Finanças. "Paga antes" (o pedido aguarda o pagamento) ou "paga até à entrega" (prepara-se, mas só se entrega ou descarrega depois de pago). O pagamento validado ou a isenção pelas Finanças fazem o pedido avançar; cancelar ou rejeitar anula a cobrança por pagar. |
| D7 | Cartões de estudante: três modelos da plataforma (Clássico, Moderno, Contemporâneo), escolha e personalização pelo colégio (cores, contactos, QR, texto do verso), fotografias (a da inscrição ou carregada pela secretaria), emissão individual e por turma, segunda via com motivo, anulação, histórico, impressão (PDF do tamanho do cartão ou folha A4 de 10 com marcas de corte) e verificação pública pelo QR ou pelo código impresso. Os pedidos de "Cartão de estudante" automáticos emitem o cartão; os preparados fora (gráfica) seguem o fluxo normal. |
| D8 | Verificação dos avisos, testes de ponta a ponta e este relatório. |

## 2. Entidades (BD de cada colégio)

| Migração | Tabelas |
|---|---|
| 0048_documents | `document_types`, `document_requests` (número por sequência, cópia do tipo e do beneficiário, revisão para não se pisarem), `document_request_events` (histórico), `document_deliveries` |
| 0049_document_issue | `document_templates` (só de acrescentar, por trigger), `issued_documents` (versões; uma só ativa por pedido), `fee_policy` e `charge_id` nos tipos e pedidos, eventos FILE e PAYMENT, `charges.kind` passa a aceitar `DOCUMENTO` |
| 0050_student_cards | `student_card_settings` (uma linha: modelo e personalização), `student_photos` (fotografia carregada pela secretaria), `student_cards` (por aluno e ano letivo, com versões; um só válido; código único; cópia do que se imprimiu) |

Permissões (nenhuma é atribuída automaticamente; o responsável do colégio atribui-as):

- Alunos: `documents.access`, `documents.settings.manage`, `documents.requests.view`, `documents.requests.process`, `documents.requests.deliver`, `documents.cards.manage`.
- Funcionários (RH): `hr.doc_types.manage`, `hr.doc_requests.view`, `hr.doc_requests.process`, `hr.doc_requests.deliver`.

Famílias: o encarregado só vê os educandos que gere (`student_guardians.can_manage`), e só enquanto são menores. O aluno maior usa a sua conta. Tudo é validado no backend.

## 3. Endpoints (`/api/v1/documents`, salvo indicação)

- **Tipos e modelos:** `GET/POST types`, `POST types/suggested`, `PUT/DELETE types/:id`, `GET/PUT types/:id/template`, `POST types/:id/template/preview`.
- **Pedidos (equipa):** `GET/POST requests`, `GET beneficiaries`, `GET requests/:id`, `POST requests/:id/{review|process|ready-pickup|ready-download|reject|cancel}`, `POST requests/:id/notes`, `POST requests/:id/delivery`, `GET requests/:id/preview`, `POST requests/:id/generate`, `POST requests/:id/upload`, `GET requests/:id/file?versao=`.
- **Funcionário:** `GET me/types`, `GET/POST me/requests`, `GET me/requests/:id`, `GET me/requests/:id/file`, `POST me/requests/:id/cancel`.
- **Cartões:** `GET cards`, `PUT cards/settings`, `POST cards/preview`, `GET cards/groups/:id`, `GET cards/groups/:id/print?formato=cartao|folha`, `GET cards/students/:id`, `GET/POST cards/students/:id/photo`, `POST cards/issue`, `GET cards/print?ids=&formato=`, `POST cards/:id/revoke`.
- **Família:** `/api/v1/family/documents`: `GET catalog`, `GET/POST requests`, `GET requests/:id`, `GET requests/:id/file`, `POST requests/:id/cancel`.
- **Público:** `GET /api/v1/public/cards/:code` (só o colégio do endereço; 30 pedidos por minuto): validade, colégio, ano letivo e o nome abreviado.
- **Finanças:** validar um pagamento ou isentar uma cobrança chama `syncDocumentFees`.

## 4. Componentes do portal

- Secretaria: `/documentos/pedidos` (+ `/[id]`, com "Documento e taxa"), `/documentos/configuracao` (+ `/[id]/modelo`), `/documentos/cartoes` (modelo + turmas por passos Ensino → Classe → Curso → Turma), `/documentos/cartoes/modelo`, `/documentos/cartoes/turmas/[id]`, `/documentos/cartoes/alunos/[id]`.
- RH: `/rh/documentos` (+ `/[id]`), `/rh/documentos/configuracao` (+ `/[id]/modelo`).
- Funcionário: `/os-meus-documentos` (+ `/[id]`).
- Família: `/familia/documentos` (+ `/[id]`); a taxa paga-se em `/familia/pagamentos` (serviço "Documento").
- Público: `/verificar` (escrever o código) e `/verificar/[codigo]` (aberta pelo QR).
- Ficheiros: route handlers que passam o ficheiro da API ao navegador (`.../ficheiro`, `.../previsualizar`, `/documentos/cartoes/imprimir`, `/documentos/cartoes/fotografia/[id]`); nunca há URL pública.
- Componentes (`features/documents/components`): `types-config`, `template-editor`, `requests-panel`, `staff-request-view`, `request-wizard`, `my-requests`, `cards-home`, `card-settings`, `cards-group`, `cards-history`, `card-verify`.

## 5. Regras importantes

- Transições validadas no backend; cada passo fica no histórico com o estado anterior, o novo, quem, quando e o motivo.
- Um documento automático não fica pronto sem ser emitido; com dados em falta não se emite e o sistema diz quais faltam. Nunca se inventam dados.
- Ficheiros (documentos, fotografias) cifrados no armazenamento do próprio colégio; downloads só pela API, com a sessão.
- Cartões: só com matrícula ativa e fotografia JPG ou PNG. A fotografia WEBP da inscrição não se imprime: pede-se uma JPG ou PNG. Válidos até ao fim do ano letivo da matrícula. A verificação diz "anulado", "substituído", "fora da validade" ou "aluno já não matriculado" quando é o caso. Reimprimir um cartão antigo leva a marca "SUBSTITUÍDO" ou "ANULADO".
- Avisos: o pedido recebido, em análise, aguarda pagamento, pagamento confirmado, em preparação (só se a equipa marcar "avisar"), pronto a levantar, disponível para download, entregue, rejeitado e cancelado. O aluno maior recebe os seus avisos; o encarregado recebe os do menor; o funcionário recebe os seus. A equipa é avisada dos pedidos novos, dos pagamentos confirmados e dos cancelamentos.
- Os documentos escolares não são documentos fiscais: o módulo não emite faturas nem recibos.

## 6. Testes

Ponta a ponta (API real, BD local isolada `eduflow_platform_e2e`, dois portais): blocos `dc` (D1–D3), `d4` (D4–D6) e `d7` (D7–D8), mais a regressão de todos os módulos anteriores. Cobrem: pedidos do aluno maior, do encarregado, de quem não é encarregado (recusado) e do funcionário; quem não tem permissão; geração de PDF; upload com validação do tipo real; dados em falta; segunda via e versões; os três modelos de cartão, personalização, emissão individual e por turma, produção externa, segunda via, anulação e verificação pública; disponível para levantamento, aviso, entrega com e sem quem recebeu; isolamento entre colégios, alunos e funcionários; pedido gratuito, com taxa, pagamento por confirmar, confirmado e isentado.

Última volta (27/11/2026): **1012 verificações certas, 2 falhas que já existiam antes deste módulo** (admissões "aprovar a A7" e assiduidade "verificar agora", ambas dependentes da data). A BD de desenvolvimento ficou intacta. Typecheck, fronteiras entre serviços e lint do portal sem erros.

## 7. Problemas conhecidos e pendentes

- Quem pede ainda não pode anexar documentos complementares: os requisitos são texto com instruções.
- O logótipo do cartão é o atual do colégio (não fica copiado em cada cartão). Ao mudar o logótipo, os cartões reimpressos saem com o novo.
- Fotografias WEBP das inscrições: o PDF não as embebe. A secretaria carrega uma JPG ou PNG. Converter automaticamente exigiria uma biblioteca de imagem.
- Relatórios estatísticos do módulo (tempos médios, volume por tipo): não incluídos. O histórico e as entregas consultam-se em cada pedido e nos painéis com filtros.
