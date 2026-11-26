# Módulo de avaliação, caderneta digital, classificações e pautas

Relatório final do módulo (fases F1 a F9, novembro de 2026). Tudo é configurável por colégio:
o sistema não traz regras universais, só predefinições editáveis. O **school-api é a fonte
oficial** de todas as contas (motor de cálculo único em `grading/domain/engine.ts`); o portal só
mostra o que a API calcula.

## 1. Funcionalidades

| Fase | O que entrega |
|---|---|
| F1 | Critérios de avaliação: modelos com versões (rascunho → publicado), componentes e pesos, elementos de avaliação, onde se aplica cada modelo (colégio › ensino › curso › classe › disciplina, por período). |
| F2 | Motor de cálculo oficial (média do período, nota do ano, exame, recuperação, arredondamentos, faltas) e simulador; guia "Como funciona" para a pedagogia. |
| F3 | Caderneta do professor: avaliações por componente, notas, faltas, dispensas, menções e apreciações, histórico só de acrescentar. |
| F4 | Ligação ao calendário de provas publicado; caderneta do professor por passos (Ensino → Classe → Curso). |
| F5 | Fecho do período: o professor submete (fica congelado) → o diretor de turma ou a pedagogia valida ou devolve (com motivo) → a direção publica por turma; retificação com motivo e nova publicação. |
| F6 | Famílias veem só o publicado (com "retificada" e o motivo); avisos à equipa e à família. |
| F7 | Final do ano (período 0): médias publicadas, frequência, exame (com provas), recuperação, com o mesmo fluxo submeter/validar/publicar; regras de transição por ensino; resultados do ano com deliberação da direção; renovação propõe a mesma classe a quem não transita; família vê a nota final e o resultado. |
| F8 | Pautas por turma e período (e a pauta final, com o resultado): A4 para imprimir ou guardar em PDF, e Excel (.xlsx verdadeiro). Só o publicado; "provisória" enquanto faltar alguma disciplina. |
| F9 | Painel da avaliação: andamento do fecho, médias e positivas por classe e por disciplina, alunos a acompanhar (2 ou mais negativas), resultados do ano. |

## 2. Entidades (BD de cada colégio)

| Migração | Tabelas |
|---|---|
| 0043_grading_criteria | `grading_models` (rascunho + revisão), `grading_model_versions` (definição imutável), `grading_rules` (âmbito único), `grading_types` (elementos de avaliação) |
| 0044_gradebook | `grading_assessments`, `grading_marks` (sem linha = por lançar), `grading_period_notes` (menção e apreciação), `grading_changes` (só de acrescentar, por trigger) |
| 0045_gradebook_exams | `grading_assessments.exam_id` (prova do calendário) |
| 0046_grading_terms | `grading_terms` (estado do fecho por turma × disciplina × período, resultados congelados), `grading_publications` (só de acrescentar) |
| 0047_grading_year | `grading_progression` (regras por ensino), `grading_final_marks` (exame e recuperação), `grading_year_decisions` (deliberação + motivo), `grading_year_results` (resultado calculado, que a renovação lê); período 0 = "Final do ano" |

Permissões: `grading.access`, `grading.settings.manage`, `grading.results.validate`,
`grading.results.publish`, `grading.results.rectify`. Os professores entram pela atribuição à
turma (`group_teachers`), não por permissão; o diretor de turma por `class_groups.coordinator_id`.

## 3. Endpoints (`/api/v1/grading`, salvo indicação)

- **Critérios:** `GET/POST models`, `GET models/:id`, `PUT/DELETE models/:id/draft`, `POST models/:id/publish`, `POST models/:id/simulate`, `DELETE models/:id`, `POST models/:id/restore`, `POST types`, `PATCH/DELETE types/:id`, `POST types/:id/restore`, `GET rules`, `PUT years/:yearId/rules`, `POST years/:yearId/rules/copy`.
- **Caderneta:** `GET me/gradebooks`, `GET gradebooks`, `GET gradebooks/:g/:s?periodo=` (0 = final do ano), `GET gradebooks/:g/:s/history`, `POST gradebooks/:g/:s/assessments`, `PATCH/DELETE assessments/:id`, `PUT assessments/:id/marks`, `PUT gradebooks/:g/:s/notes`, `PUT gradebooks/:g/:s/final-marks`.
- **Fecho:** `GET terms`, `POST gradebooks/:g/:s/term/submit`, `POST gradebooks/:g/:s/term/{validate|return|reopen}`, `POST terms/publish`.
- **Ano:** `GET progression`, `PUT progression/:level`, `GET results`, `GET results/groups/:groupId`, `POST results/decisions`.
- **Pautas e painel:** `GET sheets`, `GET sheets/:groupId?periodo=`, `GET sheets/:groupId/xlsx?periodo=`, `GET dashboard?ano=&periodo=`.
- **Família:** `GET /api/v1/family/students/:id/grades`.

## 4. Componentes do portal

- Pedagógico: `/pedagogico/painel-avaliacao` (painel), `/pedagogico/avaliacao` (critérios por passos: Modelos → Elementos → Aplicar → Transição), `/pedagogico/avaliacao/modelos/[id]` e `/simular`, `/pedagogico/avaliacao/como-funciona` (guia), `/pedagogico/cadernetas`, `/pedagogico/classificacoes` (validação e publicação), `/pedagogico/resultados` (resultados do ano e deliberação), `/pedagogico/pautas` (+ `/pedagogico/pautas/excel`), `/imprimir/pauta`.
- Professor: `/caderneta` (por passos), separador "Final do ano", `/caderneta/como-funciona`.
- Família: `/familia/classificacoes` (com o resultado do ano), aviso na renovação.
- Componentes principais (`features/grading/components`): `criteria-view`, `rules-step`, `progression-step`, `gradebook`, `final-year`, `term-panel`, `terms-view`, `results-view`, `sheets-view`, `dashboard-view`, `guide`.

## 5. Regras de cálculo (as do motor oficial)

- Somas intermédias sem arredondar; arredonda-se só a nota de cada avaliação, a média do período e a nota final, com as casas decimais e o modo do modelo.
- A cotação converte-se para a escala (`nota / cotação × máximo`).
- Faltam avaliações mínimas, ou um elemento por tipo sem notas → "por fazer" (o sistema nunca inventa notas). Falta justificada pendente → "pendente". Falta injustificada vale o definido no modelo (por omissão 0). Componente todo dispensado → o seu peso redistribui-se.
- Nota do ano: média (simples ou ponderada) das médias **publicadas** dos períodos (a última publicação, com retificações), com a versão do modelo com que o último período foi publicado.
- Classes de exame: nota final = frequência × peso + exame × peso; admissão e dispensa pela frequência; falta injustificada ao exame = mínimo da escala, justificada = pendente; o exame pode ter várias provas com pesos.
- Recuperação: só quem fica com nota final negativa e chega ao mínimo definido; a nota substitui, fica a melhor ou faz-se a média, conforme o modelo.
- Transição (por ensino): até N negativas (e até M nas disciplinas nucleares) → transita; acima do limite com recuperação ainda possível → em recuperação; senão → não transita; falta alguma nota final ou não há regra → por decidir. A deliberação da direção (com motivo) prevalece.
- Publicações e histórico são só de acrescentar (triggers na BD): nada do que foi publicado se altera nem apaga.

## 6. Testes

- Motor de cálculo: 48 casos puros; regras de transição: 16 casos puros.
- E2E (API + portal, BD local isolada `eduflow_platform_e2e`, nunca a de desenvolvimento nem a Neon): blocos por fase (critérios, motor e simulador, caderneta, calendário, fecho, famílias e avisos, final do ano e transição, pautas e painel), com capturas de cada ecrã.
- Typecheck e fronteiras entre serviços da API; tsc e eslint do portal.

## 7. Problemas conhecidos e pendentes

- Duas verificações antigas do E2E, fora deste módulo, falham sempre no ambiente de teste ("aprovar a A7: vaga guardada" e "verificar agora" da assiduidade).
- O PDF faz-se pela impressão do navegador ("Guardar como PDF"); não há geração de PDF no servidor.
- Não existe n.º de ordem oficial do aluno na turma: a pauta numera pela ordem alfabética.
- Não há transferência de alunos entre turmas nem anulação de matrícula; se vierem a existir, as cadernetas e pautas terão de as tratar.
- As notas finais das restantes disciplinas, nos testes E2E, são inseridas diretamente na BD (o percurso completo é testado em Matemática).
- O decreto executivo 106/26 (RAA) não traz as fórmulas do anexo III: os pesos do exame ficam por preencher nas predefinições, para cada colégio confirmar na norma oficial.
