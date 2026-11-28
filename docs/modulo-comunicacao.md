# Módulo de Comunicação

Avisos institucionais, mensagens individuais e grupos, com permissões configuráveis por colégio. Faseado:

| Fase | Estado | O que entrega |
|---|---|---|
| C1 | feito | Avisos: publicação por permissão (toda a comunidade ou só a equipa) e pelo diretor de turma (configuração do colégio), destinatários sem repetidos, rascunho/agendado/publicado/arquivado, expiração, fixar, confirmação de leitura, anexos, indicadores de leitura, categorias, notificações, auditoria |
| C2 | feito | Mensagens individuais (encarregado ↔ professores e diretor de turma dos educandos; aluno maior ↔ professores; equipa entre si; secretaria ↔ qualquer família com permissão), anexos, recibos (enviada, entregue, lida), arquivo, notificações sem repetição, fotografias de perfil |
| C3 | feito | Grupos manuais e ligados a turmas, classes, departamentos e à equipa, com administradores, permissões por grupo e sincronização dos membros (o histórico fica) |
| C4 | feito | Tempo real por consulta curta (`lib/live` no portal: conversa aberta 4 s, lista 10 s, contadores do menu 30 s), configuração de quem fala com quem, testes e este relatório |

## Decisões

- **Tempo real:** o projeto não tinha WebSocket nem SSE. Escolha: consulta curta (4 s na conversa aberta, 30 s para os contadores), sem dependências novas e compatível com a Vercel. As mensagens guardam-se sempre na BD, independentemente da ligação.
- **Diretor de turma:** o papel Professor não recebe permissões (só as rotas do professor). A autorização é da configuração do colégio ("os diretores de turma podem publicar para as suas turmas"), e a relação com a turma confirma-se no backend em cada gravação e na publicação (`class_groups.coordinator_id` → `employees.user_id`).
- **Estudantes:** só os alunos maiores têm conta (`family_accounts.kind = STUDENT`); os menores recebem os avisos pelos encarregados.
- **Departamentos:** os das fichas e contratos dos funcionários (texto livre).

## C1 · Avisos

### Entidades (migração `0054_communication_announcements`)

| Tabela | Conteúdo |
|---|---|
| `communication_settings` | uma linha: os diretores de turma podem publicar (por omissão, sim) |
| `announcement_categories` | as do colégio; entram Geral, Académico, Administrativo, Financeiro, Eventos, Reuniões e Urgente; arquivam-se, não se apagam |
| `announcements` | título, texto, categoria, prioridade (Normal, Alta, Urgente), estado, autoridade usada (ALL, STAFF, CLASS), publicação agendada, expiração, fixar, confirmação de leitura, revisão |
| `announcement_targets` | os destinatários escolhidos: toda a instituição, alunos, encarregados, professores, funcionários, classe, turma (alunos, encarregados ou ambos), departamento, pessoa |
| `announcement_recipients` | quem recebe, calculado na publicação e sem repetidos, com a razão (via), entregue (a notificação chegou de facto), visto e confirmado |
| `announcement_files` | anexos (PDF, JPG ou PNG até 10 MB, até 5), cifrados no armazenamento do colégio |

### Permissões

`communication.access`, `communication.announcements.publish` (toda a comunidade), `communication.announcements.staff` (só a equipa: professores, funcionários, departamentos, pessoas da equipa), `communication.announcements.manage` (todos os avisos e indicadores; sem ela, só os próprios), `communication.settings.manage`. Nenhuma é atribuída automaticamente. Receber e ler avisos não pede permissão.

### API

- Equipa (`/api/v1/communication`, também professores e RH): `GET announcements` (?categoria, q, porLer), `GET announcements/unread`, `GET announcements/:id` (fica visto), `POST announcements/:id/ack`, `GET announcements/:id/files/:fileId`.
- Gestão: `GET announcements/manage/options`, `GET announcements/manage/people?q=`, `GET/POST announcements/manage`, `GET/PUT/PATCH/DELETE announcements/manage/:id` (?leitura=VIEWED|NOT_VIEWED|ACK|NOT_ACK), `POST announcements/manage/:id/publish`, `POST announcements/manage/:id/archive`, `POST/DELETE announcements/manage/:id/files[/:fileId]`.
- Configuração: `GET/PUT settings`, `POST settings/categories`, `PUT settings/categories/:id`.
- Família (`/api/v1/family/announcements`): `GET /`, `GET unread`, `GET :id`, `POST :id/ack`, `GET :id/files/:fileId`.

### Regras

- A autoridade escolhe-se no backend: a mais estreita que cobre todos os destinatários (diretor de turma → equipa → toda a comunidade). O diretor de turma só escolhe as turmas que dirige; outra turma ou outro destinatário → 403.
- Publicado não se altera (arquiva-se e publica-se outro); só fixar e a expiração. Rascunhos apagam-se; os outros arquivam-se.
- Agendados publicam-se no ciclo das tarefas automáticas e, por precaução, ao abrir as listas. Um agendado cuja expiração já passou volta a rascunho.
- Notificações pelo sistema existente: `ANNOUNCEMENTS` e `URGENT_ANNOUNCEMENTS` (equipa; os urgentes também por email por omissão) e `FAMILY_ANNOUNCEMENTS`. Uma por pessoa e aviso. "Entregue" só quando a notificação chegou de facto (o colégio pode desligar o tipo); "visto" só ao abrir o aviso.
- Anexos só pela API, para quem gere o aviso ou o recebeu. Retirar um anexo não apaga o ficheiro.
- Auditoria em `school_activity` (criar, alterar, publicar, arquivar, apagar rascunho, anexos, categorias e configuração), sem o texto dos avisos.

### Portal

- Equipa: `/comunicacao/avisos` (Recebidos · Gerir e publicar), `/comunicacao/avisos/[id]`, `/comunicacao/avisos/novo`, `/comunicacao/avisos/gerir/[id]` (+ `/editar`), `/comunicacao/configuracao`.
- Família: `/familia/avisos` (+ `/[id]`).
- Utilizadores: atalhos da comunicação (só recebe, publicar para a equipa, para toda a comunidade, tudo).

### Testes (E2E, BD local isolada, bloco `cm`)

Publicação sem permissão (403); só para a equipa; vários destinatários sem repetidos; notificação e entrega; leitura e confirmação; isolamento (outra família, outro professor, outro colégio); agendado; diretor de turma para a sua turma, para outra turma (403) e com a configuração desligada (403); anexos (tipo real, acesso só a quem recebe); arquivo; gestão só dos próprios; categorias e auditoria.

## C2 + C3 · Mensagens e grupos

### Entidades (migração `0055_communication_messages`)

| Tabela | Conteúdo |
|---|---|
| `communication_settings` (+3) | `students_message`, `staff_message`, `teachers_create_groups` |
| `conversations` | DIRECT (uma só por par: `direct_key` único) ou GROUP (MANUAL, CLASS, GRADE, DEPARTMENT, INSTITUTION; público dos ligados; só administradores escrevem; membros juntam pessoas) |
| `conversation_members` | papel (ADMIN, MEMBER), origem (MANUAL, SYNC), entrada e saída (`left_at`: o histórico fica até à saída), lida e entregue, arquivada (só para a pessoa) |
| `messages` | TEXT ou SYSTEM ("X adicionou Y", "Entraram/Saíram") |
| `message_files` | anexos (PDF, JPG, PNG até 10 MB, até 5 por mensagem), cifrados |
| `profile_photos` | a fotografia escolhida; sem ela, o aluno com conta usa a da inscrição (ou a carregada pela secretaria) e os outros as iniciais |

### Quem fala com quem (validado no backend em cada conversa nova e em cada pessoa juntada)

- Encarregado (e aluno maior, se o colégio o permitir) → os professores (`group_teachers`) e o diretor de turma (`class_groups.coordinator_id`) das turmas dos seus alunos, nas matrículas ativas. Obrigatório.
- Professor / diretor de turma → as famílias (encarregados e alunos com conta) das turmas onde dá aulas ou que dirige; respondem sempre.
- Equipa ↔ equipa, se o colégio o permitir (professor ↔ coordenação, funcionário ↔ RH ou direção…).
- `communication.messages.families` → qualquer família do colégio (ex.: secretaria).
- Ninguém lê conversas de que não é membro: nem a direção nem o suporte (as sessões de suporte não acedem às mensagens).

### Grupos

- Criar: `communication.groups.manage` (qualquer tipo; manuais com qualquer pessoa da equipa) ou, se o colégio o permitir, os professores (manuais com os seus contactos) e o diretor de turma (o grupo da sua turma).
- Administradores: alterar o nome, a descrição, "só administradores escrevem" e "os membros juntam pessoas"; juntar, retirar, tornar administrador. O último administrador que sai passa o papel a outro.
- Ligados: os membros calculam-se das relações (encarregados/alunos das matrículas ativas, professores e diretor de turma, departamento das fichas, toda a equipa) e sincronizam-se ao abrir o grupo e no ciclo das tarefas (de 10 em 10 min). Quem deixa de pertencer sai (mensagem de sistema); quem foi retirado à mão ou saiu por vontade não volta sozinho.
- Quem sai deixa de ver as mensagens novas; vê o histórico até à saída. Novos membros veem a partir de quando entraram.

### Notificações

`MESSAGES`, `GROUP_ADDED` (equipa), `FAMILY_MESSAGES`, `FAMILY_GROUP_ADDED` (família). Uma notificação por pessoa até ler a conversa (não uma por mensagem).

### API

- Equipa (`/api/v1/communication`): `GET unread` (mensagens, conversas e avisos por ler), `GET contacts?q=`, `GET/POST conversations`, `GET conversations/:id`, `GET/POST conversations/:id/messages` (?antes=, ?depois=; multipart `body` + `files`), `POST conversations/:id/read`, `PUT conversations/:id/archive`, `GET conversations/:id/files/:fileId`, `POST groups`, `PUT groups/:id`, `POST groups/:id/members`, `DELETE groups/:id/members/:kind/:id`, `PUT groups/:id/members/:kind/:id/role`, `POST groups/:id/leave`, `GET avatars/:kind/:id`, `GET/POST/DELETE me/photo`.
- Família (`/api/v1/family/messages`): o mesmo (sem criar nem gerir grupos; pode sair).

## C4 · Tempo real

- `src/lib/live.ts` no portal: `useLive(source, onData)` (pergunta de N em N segundos, só com o separador visível, e logo ao voltar) e `useLiveCounts`. É o único sítio a mudar para passar a SSE/WebSocket.
- Conversa aberta: `messages?depois=` de 4 em 4 s (mensagens novas e recibos dos outros); lista de conversas de 10 em 10 s; contadores do menu (equipa: Comunicação; família: Mensagens e Avisos) de 30 em 30 s.
- A mensagem é guardada no servidor antes de aparecer; quem está desligado recebe-a ao voltar (e a notificação).

### Portal

- Equipa: `/comunicacao/mensagens` (+ `/[id]`): grupos (#) e mensagens diretas com fotografia, por ler, pesquisa, arquivadas; conversa com dias ("Hoje"), recibos, anexos (imagens em pré-visualização), caixa de escrita (+ anexar, Enter envia); nova conversa (procurar destinatário), novo grupo, informação do grupo (membros, administradores, juntar, retirar, sair), a minha fotografia.
- Família: `/familia/mensagens` (+ `/[id]`), com o mesmo aspeto.
- Configuração: quem fala com quem e quem cria grupos.
